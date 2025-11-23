import { Router } from 'express';
import { ExportController } from '../controllers/export.controller';
import { authMiddleware } from '../middleware/auth.middleware';
import { verifyInternalApiKey } from '../middleware/internal-api.middleware';

const router = Router();
const exportController = new ExportController();

// ══════════════════════════════════════════════════════════════════════
// PUBLIC / USER ENDPOINTS (Protected by Auth)
// ══════════════════════════════════════════════════════════════════════

/**
 * @route   POST /api/export/:projectId/export
 * @desc    Queue a video export request (triggers Step Functions)
 * @access  Private
 */
router.post(
  '/:projectId/export',
  authMiddleware,
  exportController.exportVideo.bind(exportController)
);

/**
 * @route   GET /api/export/:exportId/status
 * @desc    Get export status from database
 * @access  Private
 */
router.get(
  '/:exportId/status',
  authMiddleware,
  exportController.getExportStatus.bind(exportController)
);

/**
 * @route   GET /api/export/:exportId/execution
 * @desc    Get Step Functions execution status
 * @access  Private
 */
router.get(
  '/:exportId/execution',
  authMiddleware,
  exportController.getExecutionStatus.bind(exportController)
);

/**
 * @route   GET /api/export/history
 * @desc    Get export history for authenticated user
 * @access  Private
 */
router.get('/history', authMiddleware, exportController.getExportHistory.bind(exportController));

/**
 * @route   POST /api/export/webhook
 * @desc    Webhook endpoint for Lambda render status updates
 * @access  Public (secured by signature)
 */
router.post('/webhook', exportController.handleWebhook.bind(exportController));

/**
 * @route   DELETE /api/export/:exportId/cancel
 * @desc    Cancel an ongoing export
 * @access  Private
 */
router.delete(
  '/:exportId/cancel',
  authMiddleware,
  exportController.cancelExport.bind(exportController)
);

// ══════════════════════════════════════════════════════════════════════
// INTERNAL ENDPOINTS (Called by Lambda Worker)
// Protected by X-API-Key header
// ══════════════════════════════════════════════════════════════════════

/**
 * @route   PATCH /api/export/internal/:exportId
 * @desc    Update export status and details (Lambda only)
 * @access  Internal (X-API-Key)
 */
router.patch(
  '/internal/:exportId',
  verifyInternalApiKey,
  exportController.updateExportInternal.bind(exportController)
);

/**
 * @route   POST /api/export/internal/notification
 * @desc    Trigger user notification (Lambda only)
 * @access  Internal (X-API-Key)
 */
router.post(
  '/internal/notification',
  verifyInternalApiKey,
  exportController.sendNotificationInternal.bind(exportController)
);

export default router;
