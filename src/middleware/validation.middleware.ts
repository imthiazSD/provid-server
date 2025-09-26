import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { logger } from '../utils/logger';

export const validateRequest = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const { error } = schema.validate(req.body);
    
    if (error) {
      const errorMessage = error.details.map(detail => detail.message).join(', ');
      logger.warn('Validation error:', errorMessage);
      
      res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: error.details.map(detail => ({
          field: detail.path.join('.'),
          message: detail.message
        }))
      });
      return;
    }
    
    next();
  };
};

// Validation schemas
export const authSchemas = {
  signup: Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Please provide a valid email address',
      'any.required': 'Email is required'
    }),
    password: Joi.string().min(6).required().messages({
      'string.min': 'Password must be at least 6 characters long',
      'any.required': 'Password is required'
    }),
    name: Joi.string().trim().min(2).max(50).required().messages({
      'string.min': 'Name must be at least 2 characters long',
      'string.max': 'Name cannot exceed 50 characters',
      'any.required': 'Name is required'
    })
  }),

  signin: Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Please provide a valid email address',
      'any.required': 'Email is required'
    }),
    password: Joi.string().required().messages({
      'any.required': 'Password is required'
    })
  })
};

export const projectSchemas = {
  create: Joi.object({
    title: Joi.string().trim().min(1).max(100).required().messages({
      'string.min': 'Title cannot be empty',
      'string.max': 'Title cannot exceed 100 characters',
      'any.required': 'Title is required'
    })
  }),

  update: Joi.object({
    title: Joi.string().trim().min(1).max(100).optional(),
    thumbnailUrl: Joi.string().uri().optional(),
    previewUrl: Joi.string().uri().optional(),
    compositionSettings: Joi.object({
      videoUrl: Joi.string().uri().required(),
      duration: Joi.number().positive().optional(),
      fps: Joi.number().integer().min(1).max(120).optional(),
      width: Joi.number().integer().positive().optional(),
      height: Joi.number().integer().positive().optional(),
      layers: Joi.array().items(
        Joi.object({
          id: Joi.string().required(),
          type: Joi.string().valid('highlight', 'zoom', 'blur').required(),
          start: Joi.number().min(0).required(),
          introDuration: Joi.number().min(0).required(),
          mainDuration: Joi.number().min(0).required(),
          outroDuration: Joi.number().min(0).required(),
          data: Joi.object({
            x: Joi.number().required(),
            y: Joi.number().required(),
            width: Joi.number().positive().required(),
            height: Joi.number().positive().required(),
            color: Joi.string().optional(),
            zoomFactor: Joi.number().positive().optional(),
            blurAmount: Joi.number().min(0).optional(),
            transparency: Joi.number().min(0).max(1).optional()
          }).required()
        })
      ).optional()
    }).optional()
  }),

  autosave: Joi.object({
    compositionSettings: Joi.object({
      videoUrl: Joi.string().uri().required(),
      duration: Joi.number().positive().optional(),
      fps: Joi.number().integer().min(1).max(120).optional(),
      width: Joi.number().integer().positive().optional(),
      height: Joi.number().integer().positive().optional(),
      layers: Joi.array().items(
        Joi.object({
          id: Joi.string().required(),
          type: Joi.string().valid('highlight', 'zoom', 'blur').required(),
          start: Joi.number().min(0).required(),
          introDuration: Joi.number().min(0).required(),
          mainDuration: Joi.number().min(0).required(),
          outroDuration: Joi.number().min(0).required(),
          data: Joi.object({
            x: Joi.number().required(),
            y: Joi.number().required(),
            width: Joi.number().positive().required(),
            height: Joi.number().positive().required(),
            color: Joi.string().optional(),
            zoomFactor: Joi.number().positive().optional(),
            blurAmount: Joi.number().min(0).optional(),
            transparency: Joi.number().min(0).max(1).optional()
          }).required()
        })
      ).required()
    }).required()
  })
};