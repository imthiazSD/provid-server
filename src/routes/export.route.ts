import { Router } from 'express';
import { ExportController } from '../controllers/export.controller';
import { authMiddleware } from '../middleware/auth.middleware';

const router = Router();
const exportController = new ExportController();

// All routes require authentication except webhook
router.post('/:projectId/export', authMiddleware, exportController.exportVideo.bind(exportController));
router.get('/:exportId/status', authMiddleware, exportController.getExportStatus.bind(exportController));
router.get('/history', authMiddleware, exportController.getExportHistory.bind(exportController));

// Webhook endpoint for Lambda (no auth required)
router.post('/webhook/status', exportController.updateExportStatus.bind(exportController));

export default router;