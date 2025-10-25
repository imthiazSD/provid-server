import express from "express";
import mongoose from "mongoose";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import { RateLimiterMemory } from "rate-limiter-flexible";
import dotenv from "dotenv";

import authRoutes from "./routes/auth.route";
import projectRoutes from "./routes/project.route";
import uploadRoutes from "./routes/upload.route";
import exportRoutes from "./routes/export.route";

import {
  errorHandler,
  notFoundHandler,
} from "./middleware/errorHandler.middleware";
import { logger } from "./utils/logger";

// Load environment variables
dotenv.config();

class App {
  public express: express.Application;
  private rateLimiter: RateLimiterMemory;

  constructor() {
    this.express = express();
    this.rateLimiter = new RateLimiterMemory({
      keyPrefix: "middleware",
      points: 100, // Number of requests
      duration: 60, // Per 60 seconds
    });

    this.initializeDatabase();
    this.initializeMiddlewares();
    this.initializeRoutes();
    this.initializeErrorHandling();
  }

  private async initializeDatabase(): Promise<void> {
    try {
      const mongoUri =
        process.env.MONGODB_URI || "mongodb://localhost:27017/video-editor";

      await mongoose.connect(mongoUri, {
        retryWrites: true,
        w: "majority",
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
      });

      logger.info("Connected to MongoDB");

      // Handle database connection events
      mongoose.connection.on("error", (error) => {
        logger.error("MongoDB connection error:", error);
      });

      mongoose.connection.on("disconnected", () => {
        logger.warn("MongoDB disconnected");
      });

      mongoose.connection.on("reconnected", () => {
        logger.info("MongoDB reconnected");
      });
    } catch (error) {
      logger.error("Database connection failed:", error);
      process.exit(1);
    }
  }

  private initializeMiddlewares(): void {
    // Security middleware
    this.express.use(
      helmet({
        contentSecurityPolicy: {
          directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "https:"],
          },
        },
      })
    );

    // Rate limiting
    this.express.use(async (req, res, next) => {
      try {
        await this.rateLimiter.consume(req.ip);
        next();
      } catch (rejRes) {
        res.status(429).json({
          success: false,
          message: "Too many requests, please try again later.",
        });
      }
    });

    // CORS configuration
    this.express.use(
      cors({
        origin:
          process.env.NODE_ENV === "production"
            ? process.env.FRONTEND_URL
            : ["http://localhost:3000", "http://localhost:3001"],
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
      })
    );

    // Compression middleware
    this.express.use(compression());

    // Body parsing middleware
    this.express.use(express.json({ limit: "10mb" }));
    this.express.use(express.urlencoded({ extended: true, limit: "10mb" }));

    // Request logging
    this.express.use((req, res, next) => {
      logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get("User-Agent"),
        timestamp: new Date().toISOString(),
      });
      next();
    });
  }

  private initializeRoutes(): void {
    // Health check endpoint
    this.express.get("/health", (req, res) => {
      res.json({
        success: true,
        message: "Server is running",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV,
      });
    });

    // API routes
    this.express.use("/api/auth", authRoutes);
    this.express.use("/api/projects", projectRoutes);
    this.express.use("/api/upload", uploadRoutes);
    this.express.use("/api/exports", exportRoutes);

    // API info endpoint
    this.express.get("/api", (req, res) => {
      res.json({
        success: true,
        message: "Video Editing API",
        version: "1.0.0",
        endpoints: {
          auth: "/api/auth",
          projects: "/api/projects",
          upload: "/api/upload",
          export: "/api/export",
        },
      });
    });
  }

  private initializeErrorHandling(): void {
    // 404 handler
    this.express.use(notFoundHandler);

    // Global error handler
    this.express.use(errorHandler);

    // Graceful shutdown handling
    process.on("SIGTERM", this.gracefulShutdown.bind(this));
    process.on("SIGINT", this.gracefulShutdown.bind(this));
  }

  private async gracefulShutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}. Starting graceful shutdown...`);

    const server = this.express.listen();

    // Close server
    server.close(() => {
      logger.info("HTTP server closed");
    });

    // Close database connection
    try {
      await mongoose.connection.close();
      logger.info("Database connection closed");
    } catch (error) {
      logger.error("Error closing database connection:", error);
    }

    // Exit process
    process.exit(0);
  }

  public listen(port: number): void {
    this.express.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
      logger.info(`Health check: http://localhost:${port}/health`);
      logger.info(`API documentation: http://localhost:${port}/api`);
    });
  }
}

// Start the server
const port = parseInt(process.env.PORT || "5000", 10);
const app = new App();
app.listen(port);

export default app;
