import { Router } from 'express';
import { ExportController } from '../controllers/export.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { validateWebhookSignature } from '../middleware/webhook.middleware';

const router = Router();
const exportController = new ExportController();

// Protected routes (require authentication)
router.post(
  '/projects/:projectId/export',
  authMiddleware,
  exportController.exportVideo.bind(exportController)
);

router.get(
  '/:exportId/status',
  authMiddleware,
  exportController.getExportStatus.bind(exportController)
);

router.get(
  '/history',
  authMiddleware,
  exportController.getExportHistory.bind(exportController)
);

// Webhook endpoint (no auth, but signature validation)
router.post(
  '/webhook',
  validateWebhookSignature, // Optional: validate Remotion webhook signature
  exportController.handleWebhook.bind(exportController)
);

// Legacy manual update endpoint (keep for backward compatibility or internal use)
// router.put(
//   '/:exportId/status',
//   authMiddleware, // Or use a separate API key auth for internal services
//   exportController.updateExportStatus.bind(exportController)
// );

export default router;