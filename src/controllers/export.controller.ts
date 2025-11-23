import { Request, Response, NextFunction } from 'express';
import { ExportRequest } from '../models/export.model';
import { Project } from '../models/project.model';
import {
  SFNClient,
  StartExecutionCommand,
  DescribeExecutionCommand,
  StopExecutionCommand,
} from '@aws-sdk/client-sfn';
import { NotificationService } from '../services/notification.service';
import { logger } from '../utils/logger';
import axios from 'axios';

const sfnClient = new SFNClient({ region: process.env.AWS_REGION || 'us-east-1' });
const notificationService = new NotificationService();

export class ExportController {
  // ──────────────────────────────────────────────────────────────────────
  // 1. POST /api/export/:projectId/export → Queue render
  // ──────────────────────────────────────────────────────────────────────
  public async exportVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const { compositionId, codec } = req.body;

      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({ success: false, message: 'Project not found' });
        return;
      }

      if (!project.compositionSettings?.videoUrl) {
        res.status(400).json({ success: false, message: 'Missing video URL' });
        return;
      }

      const existing = await ExportRequest.findOne({
        projectId,
        userId,
        status: { $in: ['pending', 'queued', 'processing'] },
      });
      if (existing) {
        res.status(409).json({
          success: false,
          message: 'Export already in progress',
          data: { exportId: existing._id, status: existing.status },
        });
        return;
      }

      const exportRequest = await new ExportRequest({
        projectId,
        userId,
        status: 'queued',
        createdAt: new Date(),
      }).save();

      const input = {
        exportId: exportRequest._id.toString(),
        projectId: project._id.toString(),
        userId,
        renderConfig: {
          compositionId: compositionId || 'MainComposition',
          inputProps: {
            videoUrl: project.compositionSettings.videoUrl,
            compositionSettings: {
              ...project.compositionSettings.toObject(),
              projectId: project._id.toString(),
            },
          },
          codec: codec || 'h264',
        },
      };

      const command = new StartExecutionCommand({
        stateMachineArn: process.env.STATE_MACHINE_ARN!,
        input: JSON.stringify(input),
        name: `render-${exportRequest._id}-${Date.now()}`,
      });

      const result = await sfnClient.send(command);
      exportRequest.executionArn = result.executionArn;
      await exportRequest.save();

      res.json({
        success: true,
        data: {
          exportId: exportRequest._id,
          executionArn: result.executionArn,
          status: 'queued',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 2. GET /api/export/:exportId/status → DB status
  // ──────────────────────────────────────────────────────────────────────
  public async getExportStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { exportId } = req.params;

      const exp = await ExportRequest.findOne({ _id: exportId, userId }).populate(
        'projectId',
        'title'
      );
      if (!exp) {
        res.status(404).json({ success: false, message: 'Not found' });
        return;
      }

      res.json({
        success: true,
        data: {
          exportId: exp._id,
          status: exp.status,
          outputUrl: exp.outputUrl,
          errorMessage: exp.errorMessage,
          executionArn: exp.executionArn,
          progress: exp.progress,
          estimatedCost: exp.estimatedCost,
          createdAt: exp.createdAt,
          projectTitle: (exp.projectId as any)?.title,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 3. GET /api/export/:exportId/execution → Step Functions status
  // ──────────────────────────────────────────────────────────────────────
  public async getExecutionStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { exportId } = req.params;

      const exp = await ExportRequest.findOne({ _id: exportId, userId });
      if (!exp || !exp.executionArn) {
        res.status(404).json({ success: false, message: 'Execution not found' });
        return;
      }

      const command = new DescribeExecutionCommand({
        executionArn: exp.executionArn,
      });

      const result = await sfnClient.send(command);

      res.json({
        success: true,
        data: {
          executionArn: result.executionArn,
          status: result.status,
          startDate: result.startDate,
          stopDate: result.stopDate,
          input: result.input ? JSON.parse(result.input) : null,
          output: result.output ? JSON.parse(result.output) : null,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 4. GET /api/export/history → User export history
  // ──────────────────────────────────────────────────────────────────────
  public async getExportHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
      const skip = (page - 1) * limit;

      const [exports, total] = await Promise.all([
        ExportRequest.find({ userId })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .populate('projectId', 'title')
          .lean(),
        ExportRequest.countDocuments({ userId }),
      ]);

      res.json({
        success: true,
        data: {
          exports: exports.map(e => ({
            exportId: e._id,
            projectId: e.projectId,
            projectTitle: (e.projectId as any)?.title,
            status: e.status,
            outputUrl: e.outputUrl,
            createdAt: e.createdAt,
            progress: e.progress,
            estimatedCost: e.estimatedCost,
          })),
          pagination: {
            page,
            limit,
            total,
            pages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 5. POST /api/export/webhook → Receive Remotion webhook
  // ──────────────────────────────────────────────────────────────────────
  public async handleWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { type, exportId, outputFile, renderId, bucketName, customData, errors } = req.body;
      const taskToken = customData?.taskToken;

      if (!taskToken || !exportId) {
        res.status(400).json({ success: false, message: 'Missing taskToken or exportId' });
        return;
      }

      const action = type === 'render-completed' ? 'webhook-complete' : 'webhook-failed';

      await axios
        .post(process.env.WORKER_LAMBDA_URL!, {
          action,
          exportId,
          outputUrl: outputFile,
          taskToken,
          error: action === 'webhook-failed' ? errors?.[0] || 'Unknown error' : undefined,
        })
        .catch(err => {
          console.error('Failed to forward webhook to worker:', err.message);
        });

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 6. DELETE /api/export/:exportId/cancel → Cancel execution
  // ──────────────────────────────────────────────────────────────────────
  public async cancelExport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { exportId } = req.params;

      const exp = await ExportRequest.findOne({ _id: exportId, userId });
      if (!exp) {
        res.status(404).json({ success: false, message: 'Export not found' });
        return;
      }

      if (!['queued', 'processing'].includes(exp.status)) {
        res.status(400).json({ success: false, message: 'Export cannot be canceled' });
        return;
      }

      if (exp.executionArn) {
        await sfnClient.send(
          new StopExecutionCommand({
            executionArn: exp.executionArn,
            cause: 'Canceled by user',
          })
        );
      }

      exp.status = 'failed';
      exp.errorMessage = 'Canceled by user';
      await exp.save();

      res.json({
        success: true,
        message: 'Export canceled',
        data: { exportId, status: 'failed' },
      });
    } catch (error) {
      next(error);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // INTERNAL ENDPOINTS (Called by Lambda Worker)
  // ══════════════════════════════════════════════════════════════════════

  // ──────────────────────────────────────────────────────────────────────
  // 7. PATCH /api/export/internal/:exportId → Update export (Lambda only)
  // ──────────────────────────────────────────────────────────────────────
  public async updateExportInternal(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { exportId } = req.params;
      const updates = req.body;

      logger.info('Internal: Updating export from Lambda', { exportId, updates });

      if (!exportId || exportId.length !== 24) {
        res.status(400).json({ success: false, message: 'Invalid exportId' });
        return;
      }

      const exportRequest = await ExportRequest.findByIdAndUpdate(
        exportId,
        {
          $set: {
            ...updates,
            updatedAt: new Date(),
          },
        },
        { new: true, runValidators: true }
      );

      if (!exportRequest) {
        logger.warn('Internal: Export not found', { exportId });
        res.status(404).json({ success: false, message: 'Export not found' });
        return;
      }

      logger.info('Internal: Export updated successfully', {
        exportId,
        status: exportRequest.status,
      });

      res.json({
        success: true,
        data: exportRequest,
      });
    } catch (error: any) {
      logger.error('Internal: Update export error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to update export',
        error: error.message,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // 8. POST /api/export/internal/notification → Send notification (Lambda only)
  // ──────────────────────────────────────────────────────────────────────
  public async sendNotificationInternal(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { userId, exportId, projectId, status, outputUrl, errorMessage } = req.body;

      logger.info('Internal: Sending notification from Lambda', {
        userId,
        exportId,
        status,
      });

      if (!userId || !exportId || !status) {
        res.status(400).json({
          success: false,
          message: 'Missing required fields: userId, exportId, status',
        });
        return;
      }

      const exportRequest = await ExportRequest.findById(exportId);

      if (!exportRequest) {
        logger.warn('Internal: Export not found for notification', { exportId });
        res.status(404).json({ success: false, message: 'Export not found' });
        return;
      }

      // Update export with latest data if provided
      if (outputUrl) exportRequest.outputUrl = outputUrl;
      if (errorMessage) exportRequest.errorMessage = errorMessage;
      exportRequest.status = status;

      // Send notification via NotificationService
      await notificationService.sendExportNotification(userId, exportRequest, status);

      logger.info('Internal: Notification sent successfully', {
        userId,
        exportId,
        status,
      });

      res.json({
        success: true,
        message: 'Notification sent',
      });
    } catch (error: any) {
      logger.error('Internal: Send notification error:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to send notification',
        error: error.message,
      });
    }
  }
}
