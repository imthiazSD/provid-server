// src/routes/notification.route.ts
import { Router } from 'express';
import { NotificationController } from '../controllers/notification.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validate } from '../middleware/validation.middleware';
import { notificationSchemas } from '../validation/schemas';

const router = Router();
const controller = new NotificationController();

router.get(
  '/',
  authMiddleware,
  validate(notificationSchemas.get, 'query'),
  controller.getNotifications.bind(controller)
);

// Mark one as read
router.patch('/:id/read', authMiddleware, controller.markAsRead.bind(controller));

// Mark all as read
router.patch('/read-all', authMiddleware, controller.markAllAsRead.bind(controller));

export default router;
