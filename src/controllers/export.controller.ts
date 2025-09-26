import { NextFunction, Request, Response } from 'express';
import { ExportRequest } from '../models/export.model';
import { Project } from '../models/project.model';
import { NotificationService } from '../services/notification.service';
import { SQSService } from '../services/sqs.service';
import { logger } from '../utils/logger';

export class ExportController {
  private sqsService: SQSService;
  private notificationService: NotificationService;

  constructor() {
    this.sqsService = new SQSService();
    this.notificationService = new NotificationService();
  }

  public async exportVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found'
        });
        return;
      }

      // Check if video URL exists
      if (!project.compositionSettings.videoUrl) {
        res.status(400).json({
          success: false,
          message: 'No video uploaded for this project'
        });
        return;
      }

      // Check for existing pending/processing export
      const existingExport = await ExportRequest.findOne({
        projectId,
        userId,
        status: { $in: ['pending', 'processing'] }
      });

      if (existingExport) {
        res.status(409).json({
          success: false,
          message: 'Export already in progress for this project',
          data: {
            exportId: existingExport._id,
            status: existingExport.status
          }
        });
        return;
      }

      // Create export request
      const exportRequest = new ExportRequest({
        projectId,
        userId,
        status: 'pending'
      });

      await exportRequest.save();

      // Prepare message for SQS
      const messageBody = {
        exportId: exportRequest._id,
        projectId: project._id,
        userId: userId,
        compositionSettings: project.compositionSettings,
        timestamp: new Date().toISOString()
      };

      // Send message to SQS queue
      const messageId = await this.sqsService.sendMessage(JSON.stringify(messageBody));
      
      // Update export request with message ID
      exportRequest.queueMessageId = messageId;
      await exportRequest.save();

      logger.info(`Export request queued: ${exportRequest._id} for project: ${projectId}`);

      res.json({
        success: true,
        message: 'Export request queued successfully',
        data: {
          exportId: exportRequest._id,
          status: exportRequest.status,
          estimatedTime: '5-10 minutes'
        }
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

      const exportRequest = await ExportRequest.findOne({ _id: exportId, userId })
        .populate('projectId', 'title');

      if (!exportRequest) {
        res.status(404).json({
          success: false,
          message: 'Export request not found'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          exportId: exportRequest._id,
          projectId: exportRequest.projectId,
          status: exportRequest.status,
          outputUrl: exportRequest.outputUrl,
          errorMessage: exportRequest.errorMessage,
          createdAt: exportRequest.createdAt,
          updatedAt: exportRequest.updatedAt
        }
      });
    } catch (error) {
      logger.error('Get export status error:', error);
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
            createdAt: exp.createdAt,
            updatedAt: exp.updatedAt
          })),
          pagination: {
            current: page,
            pages: Math.ceil(total / limit),
            total
          }
        }
      });
    } catch (error) {
      logger.error('Get export history error:', error);
      next(error);
    }
  }

  public async updateExportStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { exportId, status, outputUrl, errorMessage } = req.body;

      const exportRequest = await ExportRequest.findById(exportId);
      if (!exportRequest) {
        res.status(404).json({
          success: false,
          message: 'Export request not found'
        });
        return;
      }

      // Update export status
      exportRequest.status = status;
      if (outputUrl) exportRequest.outputUrl = outputUrl;
      if (errorMessage) exportRequest.errorMessage = errorMessage;
      exportRequest.updatedAt = new Date();
      
      await exportRequest.save();

      // Send notification to user
      await this.notificationService.sendExportNotification(
        exportRequest.userId.toString(),
        exportRequest,
        status
      );

      logger.info(`Export status updated: ${exportId} - ${status}`);

      res.json({
        success: true,
        message: 'Export status updated successfully'
      });
    } catch (error) {
      logger.error('Update export status error:', error);
      next(error);
    }
  }
}