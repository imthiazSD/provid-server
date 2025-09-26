import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import dotenv from 'dotenv';
import { createServer } from 'http';

import authRoutes from './routes/auth.route';
import projectRoutes from './routes/project.route';
import uploadRoutes from './routes/upload.route';
import exportRoutes from './routes/export.route';

import { errorHandler, notFoundHandler } from './middleware/errorHandler.middleware';
import { logger } from './utils/logger';

dotenv.config();

class App {
  public express: express.Application;
  public server: any;
  private rateLimiter: RateLimiterMemory;

  constructor() {
    this.express = express();
    this.server = createServer(this.express);
    
    this.rateLimiter = new RateLimiterMemory({
      keyPrefix: 'middleware',
      points: 100,
      duration: 60,
    });

    this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private async initializeDatabase(): Promise<void> {
    try {
      const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/video-editor';
      
      await mongoose.connect(mongoUri, {
        retryWrites: true,
        w: 'majority',
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });

      logger.info('Connected to MongoDB');
    } catch (error) {
      logger.error('Database connection failed:', error);
      process.exit(1);
    }
  }

  private initializeMiddlewares(): void {
    this.express.use(helmet());
    this.express.use(cors({
      origin: process.env.NODE_ENV === 'production' 
        ? process.env.FRONTEND_URL 
        : ['http://localhost:3000', 'http://localhost:3001'],
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }));
    this.express.use(compression());
    this.express.use(express.json({ limit: '10mb' }));
    this.express.use(express.urlencoded({ extended: true, limit: '10mb' }));
  }

  private initializeRoutes(): void {
    this.express.get('/health', (req, res) => {
      res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV,
      });
    });

    this.express.use('/api/auth', authRoutes);
    this.express.use('/api/projects', projectRoutes);
    this.express.use('/api/upload', uploadRoutes);
    this.express.use('/api/export', exportRoutes);
  }

  private initializeErrorHandling(): void {
    this.express.use(notFoundHandler);
    this.express.use(errorHandler);
  }

  public listen(port: number): void {
    this.server.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
    });
  }
}

const port = parseInt(process.env.PORT || '5000', 10);
const app = new App();
app.listen(port);

export default app;