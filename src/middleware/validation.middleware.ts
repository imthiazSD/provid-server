// src/middleware/validate.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { logger } from '../utils/logger';

export const validate =
  (schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = source === 'body' ? req.body : source === 'query' ? req.query : req.params;
      schema.parse(data);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message,
        }));

        logger.warn('Validation error', { errors, source });

        res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors,
        });
      } else {
        logger.error('Unexpected validation error', { error });
        res.status(500).json({ success: false, message: 'Internal server error' });
      }
    }
  };
