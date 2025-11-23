// src/controllers/notification.controller.ts
import { Request, Response, NextFunction } from 'express';
import { Notification, INotification } from '../models/notification.model';
import { logger } from '../utils/logger';

export class NotificationController {
  /**
   * GET /api/notifications?page=1&limit=20&read=all
   * Fetch notifications for authenticated user
   */
  public async getNotifications(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId; // From auth middleware
      const {
        page = '1',
        limit = '20',
        read = 'all',
      } = req.query as {
        page?: string;
        limit?: string;
        read?: 'true' | 'false' | 'all';
      };

      const pageNum = parseInt(page);
      const limitNum = Math.min(parseInt(limit), 100); // Max 100 per page
      const skip = (pageNum - 1) * limitNum;

      // Build filter
      const filter: any = { userId };
      if (read !== 'all') {
        filter.read = read === 'true';
      }

      const [notifications, total] = await Promise.all([
        Notification.find(filter).sort({ timestamp: -1 }).skip(skip).limit(limitNum).lean(),
        Notification.countDocuments(filter),
      ]);

      const hasMore = skip + notifications.length < total;

      res.json({
        success: true,
        data: {
          notifications,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
            hasMore,
          },
        },
      });

      logger.info('Fetched notifications', {
        userId,
        count: notifications.length,
        page: pageNum,
      });
    } catch (error: any) {
      logger.error('Get notifications error', {
        error: error.message,
        userId: (req as any).userId,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to fetch notifications',
      });
    }
  }

  /**
   * PATCH /api/notifications/:id/read
   * Mark a single notification as read
   */
  public async markAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = (req as any).userId;

      const notification = await Notification.findOneAndUpdate(
        { _id: id, userId }, // Ensure user owns this notification
        { read: true },
        { new: true }
      );

      if (!notification) {
        res.status(404).json({
          success: false,
          message: 'Notification not found',
        });
        return;
      }

      res.json({
        success: true,
        data: notification,
      });

      logger.info('Marked notification as read', {
        notificationId: id,
        userId,
      });
    } catch (error: any) {
      logger.error('Mark as read error', {
        error: error.message,
        notificationId: req.params.id,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to update notification',
      });
    }
  }

  /**
   * PATCH /api/notifications/read-all
   * Mark all notifications as read for authenticated user
   */
  public async markAllAsRead(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;

      const result = await Notification.updateMany({ userId, read: false }, { read: true });

      res.json({
        success: true,
        data: {
          modifiedCount: result.modifiedCount,
          message: `${result.modifiedCount} notifications marked as read`,
        },
      });

      logger.info('Marked all as read', {
        userId,
        modified: result.modifiedCount,
      });
    } catch (error: any) {
      logger.error('Mark all as read error', {
        error: error.message,
        userId: (req as any).userId,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to update notifications',
      });
    }
  }

  /**
   * GET /api/notifications/unread-count
   * Get count of unread notifications
   */
  public async getUnreadCount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;

      const count = await Notification.countDocuments({
        userId,
        read: false,
      });

      res.json({
        success: true,
        data: { unreadCount: count },
      });

      logger.debug('Fetched unread count', { userId, count });
    } catch (error: any) {
      logger.error('Get unread count error', {
        error: error.message,
        userId: (req as any).userId,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to get unread count',
      });
    }
  }

  /**
   * DELETE /api/notifications/:id
   * Delete a single notification
   */
  public async deleteNotification(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      const userId = (req as any).userId;

      const notification = await Notification.findOneAndDelete({
        _id: id,
        userId, // Ensure user owns this notification
      });

      if (!notification) {
        res.status(404).json({
          success: false,
          message: 'Notification not found',
        });
        return;
      }

      res.json({
        success: true,
        message: 'Notification deleted',
      });

      logger.info('Deleted notification', {
        notificationId: id,
        userId,
      });
    } catch (error: any) {
      logger.error('Delete notification error', {
        error: error.message,
        notificationId: req.params.id,
      });
      res.status(500).json({
        success: false,
        message: 'Failed to delete notification',
      });
    }
  }
}
