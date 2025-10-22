import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { logger } from '../utils/logger';

export const validateWebhookSignature = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  try {
    const signature = req.headers['x-remotion-signature'] as string;
    const webhookSecret = process.env.WEBHOOK_SECRET;

    // If no secret is configured, skip validation (dev mode)
    if (!webhookSecret) {
      logger.warn('Webhook secret not configured, skipping signature validation');
      return next();
    }

    // If signature is missing, reject
    if (!signature) {
      res.status(401).json({
        success: false,
        message: 'Missing webhook signature'
      });
      return;
    }

    // Compute expected signature
    const payload = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(payload)
      .digest('hex');

    // Compare signatures (timing-safe comparison)
    const isValid = crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );

    if (!isValid) {
      logger.error('Invalid webhook signature');
      res.status(401).json({
        success: false,
        message: 'Invalid webhook signature'
      });
      return;
    }

    next();
  } catch (error) {
    logger.error('Webhook signature validation error:', error);
    res.status(500).json({
      success: false,
      message: 'Webhook validation failed'
    });
  }
};