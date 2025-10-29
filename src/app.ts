import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import dotenv from 'dotenv';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';

import authRoutes from './routes/auth.route';
import projectRoutes from './routes/project.route';
import uploadRoutes from './routes/upload.route';
import exportRoutes from './routes/export.route';
import notificationRoutes from './routes/notification.route';

import { errorHandler, notFoundHandler } from './middleware/errorHandler.middleware';
import { logger } from './utils/logger';

// Load environment variables
dotenv.config();

class App {
  public express: express.Application;
  private rateLimiter: RateLimiterMemory;
  private httpServer: http.Server;
  private io: SocketIOServer;

  constructor() {
    this.express = express();
    this.rateLimiter = new RateLimiterMemory({
      keyPrefix: 'middleware',
      points: 100, // 100 requests
      duration: 60, // per minute
    });

    this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeSocketIO();
    this.initializeErrorHandling();
  }

  private async initializeDatabase(): Promise<void> {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/video-editor';

      await mongoose.connect(mongoUri, {
        retryWrites: true,
        w: 'majority',
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });

      logger.info('Connected to MongoDB');

      // Connection events
      mongoose.connection.on('error', err => {
        logger.error('MongoDB connection error:', err);
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('MongoDB disconnected');
      });

      mongoose.connection.on('reconnected', () => {
        logger.info('MongoDB reconnected');
      });
    } catch (error) {
      logger.error('Database connection failed:', error);
      process.exit(1);
    }
  }

  private initializeMiddlewares(): void {
    // Security: Helmet
    this.express.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
          },
        },
      })
    );

    // Rate limiting
    this.express.use(async (req, res, next) => {
      try {
        await this.rateLimiter.consume(req.ip);
        next();
      } catch {
        res.status(429).json({
          success: false,
          message: 'Too many requests. Please try again later.',
        });
      }
    });

    // CORS
    this.express.use(
      cors({
        origin:
          process.env.NODE_ENV === 'production'
            ? process.env.FRONTEND_URL
            : ['http://localhost:3000', 'http://localhost:3001'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      })
    );

    // Compression
    this.express.use(compression());

    // Body parsing
    this.express.use(express.json({ limit: '10mb' }));
    this.express.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Request logging
    this.express.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString(),
      });
      next();
    });
  }

  private initializeRoutes(): void {
    // Health check
    this.express.get('/health', (req, res) => {
      const socketCount = this.io?.engine?.clientsCount || 0;
      res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV,
        mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        socketsConnected: socketCount,
      });
    });

    // API Info
    this.express.get('/api', (req, res) => {
      res.json({
        success: true,
        message: 'Video Editing API',
        version: '1.0.0',
        endpoints: {
          auth: '/api/auth',
          projects: '/api/projects',
          upload: '/api/upload',
          exports: '/api/exports',
        },
      });
    });

    // Routes
    this.express.use('/api/auth', authRoutes);
    this.express.use('/api/projects', projectRoutes);
    this.express.use('/api/upload', uploadRoutes);
    this.express.use('/api/exports', exportRoutes);
    this.express.use('/api/notifications', notificationRoutes);
  }

  private initializeSocketIO(): void {
    // Create HTTP server
    this.httpServer = http.createServer(this.express);

    // Initialize Socket.IO
    this.io = new SocketIOServer(this.httpServer, {
      cors: {
        origin:
          process.env.NODE_ENV === 'production'
            ? process.env.FRONTEND_URL
            : ['http://localhost:3000', 'http://localhost:3001'],
        methods: ['GET', 'POST'],
        credentials: true,
      },
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // Connection handling
    this.io.on('connection', socket => {
      logger.info('Socket connected', {
        socketId: socket.id,
        ip: socket.handshake.address,
      });

      // Join user-specific room
      socket.on('join', (userId: string) => {
        if (userId) {
          const room = `user_${userId}`;
          socket.join(room);
          logger.info('User joined room', { userId, room, socketId: socket.id });
        }
      });

      socket.on('disconnect', reason => {
        logger.info('Socket disconnected', { socketId: socket.id, reason });
      });

      socket.on('error', err => {
        logger.error('Socket error', { socketId: socket.id, error: err });
      });
    });

    // Make io globally accessible
    (global as any).io = this.io;
  }

  private initializeErrorHandling(): void {
    this.express.use(notFoundHandler);
    this.express.use(errorHandler);

    // Graceful shutdown
    process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    // Close Socket.IO
    if (this.io) {
      this.io.close(() => {
        logger.info('Socket.IO server closed');
      });
    }

    // Close HTTP server
    this.httpServer.close(() => {
      logger.info('HTTP server closed');
    });

    // Close MongoDB
    try {
      await mongoose.connection.close();
      logger.info('MongoDB connection closed');
    } catch (error) {
      logger.error('Error closing MongoDB:', error);
    }

    logger.info('Graceful shutdown complete');
    process.exit(0);
  }

  public listen(port: number): void {
    this.httpServer.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
      logger.info(`Health check: http://localhost:${port}/health`);
      logger.info(`API docs: http://localhost:${port}/api`);
      logger.info(`WebSocket: ws://localhost:${port}/socket.io`);
    });
  }

  // Optional: Getter for DI
  public getIO(): SocketIOServer {
    return this.io;
  }
}

// Start the server
const port = parseInt(process.env.PORT || '5000', 10);
const app = new App();
app.listen(port);

export default app;
