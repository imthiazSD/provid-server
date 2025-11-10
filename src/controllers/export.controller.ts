import { NextFunction, Request, Response } from 'express';
import { ExportRequest } from '../models/export.model';
import { Project } from '../models/project.model';
import { NotificationService } from '../services/notification.service';
import { RemotionSQSService } from '../services/remotion-sqs.service';
import { logger } from '../utils/logger';
import { WEBHOOK_URL } from '../utils/constants';

export class ExportController {
  private remotionSQSService: RemotionSQSService;
  private notificationService: NotificationService;

  constructor() {
    this.remotionSQSService = new RemotionSQSService();
    this.notificationService = new NotificationService();
  }

  public async exportVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const { compositionId, codec } = req.body;

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found',
        });
        return;
      }

      // Check if video URL exists and is a valid string
      if (
        !project.compositionSettings.videoUrl ||
        typeof project.compositionSettings.videoUrl !== 'string'
      ) {
        res.status(400).json({
          success: false,
          message: 'Invalid or missing video URL for this project',
        });
        return;
      }

      // Check for existing pending/processing export
      const existingExport = await ExportRequest.findOne({
        projectId,
        userId,
        status: { $in: ['pending', 'queued', 'processing'] },
      });

      if (existingExport) {
        res.status(409).json({
          success: false,
          message: 'Export already in progress for this project',
          data: {
            exportId: existingExport._id,
            status: existingExport.status,
            executionArn: existingExport.executionArn,
          },
        });
        return;
      }

      // Create export request
      const exportRequest = new ExportRequest({
        projectId,
        userId,
        status: 'pending',
        createdAt: new Date(),
      });

      await exportRequest.save();

      // Prepare webhook URL for status updates
      const webhookUrl = WEBHOOK_URL;

      // Convert compositionSettings to plain object and structure inputProps
      const { videoUrl, ...otherSettings } = project.compositionSettings.toObject
        ? project.compositionSettings.toObject()
        : project.compositionSettings;

      const inputProps = {
        videoUrl,
        compositionSettings: {
          ...otherSettings,
          projectId: project._id.toString(),
        },
      };

      // Log inputProps for debugging
      logger.info('Constructed inputProps:', JSON.stringify(inputProps, null, 2));

      // Enqueue render request to SQS (will trigger Step Functions)
      const messageId = await this.remotionSQSService.enqueueRenderRequest({
        exportId: exportRequest._id.toString(),
        projectId: project._id.toString(),
        userId: userId,
        compositionId: compositionId || 'MainComposition',
        inputProps,
        codec: codec || 'h264',
        webhookUrl,
      });

      // Update export request with queue message ID
      exportRequest.queueMessageId = messageId;
      await exportRequest.save();

      logger.info(
        `Export request queued: ${exportRequest._id} for project: ${projectId}, messageId: ${messageId}`
      );

      res.json({
        success: true,
        message: 'Export request queued successfully. Step Functions will handle the render.',
        data: {
          exportId: exportRequest._id,
          queueMessageId: messageId,
          status: exportRequest.status,
          estimatedTime: '2-5 minutes',
          note: 'Render will execute serially. Check status endpoint for updates.',
        },
      });
    } catch (error) {
      logger.error('Export video error:', error);
      next(error);
    }
  }

  public async getExportStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { exportId } = req.params;

      const exportRequest = await ExportRequest.findOne({
        _id: exportId,
        userId,
      }).populate('projectId', 'title');

      if (!exportRequest) {
        res.status(404).json({
          success: false,
          message: 'Export request not found',
        });
        return;
      }

      // Build response with available data
      const responseData: any = {
        exportId: exportRequest._id,
        projectId: exportRequest.projectId,
        status: exportRequest.status,
        outputUrl: exportRequest.outputUrl,
        errorMessage: exportRequest.errorMessage,
        executionArn: exportRequest.executionArn,
        renderId: exportRequest.renderId,
        bucketName: exportRequest.bucketName,
        createdAt: exportRequest.createdAt,
        updatedAt: exportRequest.updatedAt,
      };

      // If processing and we have progress data
      if (exportRequest.progress !== undefined && exportRequest.progress !== null) {
        responseData.progress = {
          percent: exportRequest.progress,
        };
      }

      // Add helpful status descriptions
      const statusDescriptions: Record<string, string> = {
        pending: 'Export queued, waiting to start',
        queued: 'Export in Step Functions queue',
        processing: 'Render in progress',
        completed: 'Render completed successfully',
        failed: 'Render failed',
      };

      responseData.statusDescription = statusDescriptions[exportRequest.status] || 'Unknown status';

      res.json({
        success: true,
        data: responseData,
      });
    } catch (error) {
      logger.error('Get export status error:', error);
      next(error);
    }
  }

  /**
   * Get Step Functions execution status
   * Additional endpoint to check Step Functions execution
   */
  public async getExecutionStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { exportId } = req.params;

      const exportRequest = await ExportRequest.findOne({
        _id: exportId,
        userId,
      });

      if (!exportRequest) {
        res.status(404).json({
          success: false,
          message: 'Export request not found',
        });
        return;
      }

      if (!exportRequest.executionArn) {
        res.status(400).json({
          success: false,
          message: 'No Step Functions execution found for this export',
        });
        return;
      }

      // Get execution status from Step Functions
      try {
        const executionStatus = await this.remotionSQSService.getStepFunctionsExecutionStatus(
          exportRequest.executionArn
        );

        res.json({
          success: true,
          data: {
            exportId: exportRequest._id,
            executionArn: exportRequest.executionArn,
            executionStatus,
          },
        });
      } catch (sfnError) {
        logger.error('Failed to get Step Functions execution status:', sfnError);
        res.status(500).json({
          success: false,
          message: 'Failed to retrieve execution status from Step Functions',
        });
      }
    } catch (error) {
      logger.error('Get execution status error:', error);
      next(error);
    }
  }

  public async getExportHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;

      const exports = await ExportRequest.find({ userId })
        .populate('projectId', 'title')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit);

      const total = await ExportRequest.countDocuments({ userId });

      res.json({
        success: true,
        data: {
          exports: exports.map(exp => ({
            id: exp._id,
            projectId: exp.projectId,
            status: exp.status,
            outputUrl: exp.outputUrl,
            errorMessage: exp.errorMessage,
            executionArn: exp.executionArn,
            progress: exp.progress,
            createdAt: exp.createdAt,
            updatedAt: exp.updatedAt,
          })),
          pagination: {
            current: page,
            pages: Math.ceil(total / limit),
            total,
          },
        },
      });
    } catch (error) {
      logger.error('Get export history error:', error);
      next(error);
    }
  }

  /**
   * Webhook endpoint that receives updates from the Lambda render function
   * The Lambda function calls this after each action (started, completed, failed)
   */
  public async handleWebhook(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { type, exportId, renderId, bucketName, outputFile, errors, projectId } = req.body;

      // Verify webhook signature if configured
      const signature = req.headers['x-remotion-signature'];
      if (process.env.WEBHOOK_SECRET && signature) {
        const crypto = await import('crypto');
        const expectedSignature = crypto
          .createHmac('sha256', process.env.WEBHOOK_SECRET)
          .update(JSON.stringify(req.body))
          .digest('hex');

        if (signature !== expectedSignature) {
          logger.warn('Invalid webhook signature');
          res.status(401).json({ success: false, message: 'Invalid signature' });
          return;
        }
      }

      const exportRequest = await ExportRequest.findById(exportId);
      if (!exportRequest) {
        logger.warn(`Webhook received for non-existent export: ${exportId}`);
        res.status(404).json({ success: false, message: 'Export not found' });
        return;
      }

      // Handle different webhook types
      switch (type) {
        case 'render_started':
          exportRequest.status = 'processing';
          exportRequest.renderId = renderId;
          exportRequest.bucketName = bucketName;
          await exportRequest.save();

          logger.info(`Render started: ${exportId}, renderId: ${renderId}`);
          break;

        case 'render_success':
          exportRequest.status = 'completed';
          exportRequest.outputUrl = outputFile;
          exportRequest.renderId = renderId;
          exportRequest.bucketName = bucketName;
          exportRequest.progress = 100;
          await exportRequest.save();

          await this.notificationService.sendExportNotification(
            exportRequest.userId.toString(),
            exportRequest,
            'completed'
          );

          logger.info(`Export completed: ${exportId}`);
          break;

        case 'render_error':
          exportRequest.status = 'failed';
          exportRequest.errorMessage = errors?.[0]?.message || 'Render failed';
          await exportRequest.save();

          await this.notificationService.sendExportNotification(
            exportRequest.userId.toString(),
            exportRequest,
            'failed'
          );

          logger.error(`Export failed: ${exportId}`, errors);
          break;

        case 'render_timeout':
          exportRequest.status = 'failed';
          exportRequest.errorMessage = 'Render timeout';
          await exportRequest.save();

          await this.notificationService.sendExportNotification(
            exportRequest.userId.toString(),
            exportRequest,
            'failed'
          );

          logger.error(`Export timeout: ${exportId}`);
          break;

        default:
          logger.warn(`Unknown webhook type: ${type}`);
      }

      res.json({ success: true });
    } catch (error) {
      logger.error('Webhook handler error:', error);
      next(error);
    }
  }

  /**
   * Cancel an ongoing export
   */
  public async cancelExport(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { exportId } = req.params;

      const exportRequest = await ExportRequest.findOne({
        _id: exportId,
        userId,
      });

      if (!exportRequest) {
        res.status(404).json({
          success: false,
          message: 'Export request not found',
        });
        return;
      }

      if (!['pending', 'queued', 'processing'].includes(exportRequest.status)) {
        res.status(400).json({
          success: false,
          message: `Cannot cancel export with status: ${exportRequest.status}`,
        });
        return;
      }

      // Stop Step Functions execution if it exists
      if (exportRequest.executionArn) {
        try {
          await this.remotionSQSService.stopStepFunctionsExecution(
            exportRequest.executionArn,
            'User requested cancellation'
          );
          logger.info(`Stopped Step Functions execution: ${exportRequest.executionArn}`);
        } catch (error) {
          logger.error('Failed to stop Step Functions execution:', error);
        }
      }

      exportRequest.status = 'failed';
      exportRequest.errorMessage = 'Cancelled by user';
      await exportRequest.save();

      logger.info(`Export cancelled: ${exportId}`);

      res.json({
        success: true,
        message: 'Export cancelled successfully',
        data: {
          exportId: exportRequest._id,
          status: exportRequest.status,
        },
      });
    } catch (error) {
      logger.error('Cancel export error:', error);
      next(error);
    }
  }
}