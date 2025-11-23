// src/middleware/internal-api.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

/**
 * Middleware to verify internal API calls from Lambda
 * Checks for X-API-Key header matching API_SECRET_KEY env variable
 */
export const verifyInternalApiKey = (req: Request, res: Response, next: NextFunction): void => {
  const apiKey = req.headers['x-api-key'] as string;
  const expectedKey = process.env.API_SECRET_KEY;

  // If no secret key is configured, log a warning but allow (for development)
  if (!expectedKey) {
    logger.warn('API_SECRET_KEY not configured - internal endpoints are unprotected!', {
      path: req.path,
      ip: req.ip,
    });
    return next();
  }

  // Verify the API key
  if (!apiKey) {
    logger.warn('Internal API call missing X-API-Key header', {
      path: req.path,
      ip: req.ip,
    });
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Missing API key',
    });
    return;
  }

  if (apiKey !== expectedKey) {
    logger.warn('Internal API call with invalid X-API-Key', {
      path: req.path,
      ip: req.ip,
      receivedKeyLength: apiKey.length,
    });
    res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid API key',
    });
    return;
  }

  // API key is valid
  logger.debug('Internal API key verified', {
    path: req.path,
  });

  next();
};
