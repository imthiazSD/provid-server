// src/routes/notification.routes.ts
import { Router } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const controller = new NotificationController();

/**
 * @route   GET /api/notifications
 * @desc    Get paginated notifications for authenticated user
 * @query   page, limit, read (true|false|all)
 * @access  Private
 */
router.get('/', authMiddleware, controller.getNotifications.bind(controller));

/**
 * @route   GET /api/notifications/unread-count
 * @desc    Get count of unread notifications
 * @access  Private
 */
router.get('/unread-count', authMiddleware, controller.getUnreadCount.bind(controller));

/**
 * @route   PATCH /api/notifications/:id/read
 * @desc    Mark a single notification as read
 * @access  Private
 */
router.patch('/:id/read', authMiddleware, controller.markAsRead.bind(controller));

/**
 * @route   PATCH /api/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.patch('/read-all', authMiddleware, controller.markAllAsRead.bind(controller));

/**
 * @route   DELETE /api/notifications/:id
 * @desc    Delete a notification
 * @access  Private
 */
router.delete('/:id', authMiddleware, controller.deleteNotification.bind(controller));

export default router;
