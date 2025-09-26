import { Request, Response, NextFunction } from 'express';
import { S3Service } from '../services/s3.service';
import { Project } from '../models/project.model';
import { logger } from '../utils/logger';

export class UploadController {
  private s3Service: S3Service;

  constructor() {
    this.s3Service = new S3Service();
  }

  public async uploadVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          success: false,
          message: 'No file uploaded'
        });
        return;
      }

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found'
        });
        return;
      }

      // Upload to S3
      const videoUrl = await this.s3Service.uploadFile(
        file.buffer,
        `videos/${userId}/${projectId}/${file.originalname}`,
        file.mimetype
      );

      // Update project with video URL
      await Project.findByIdAndUpdate(projectId, {
        'compositionSettings.videoUrl': videoUrl,
        updatedAt: new Date()
      });

      logger.info(`Video uploaded for project: ${projectId}, URL: ${videoUrl}`);

      res.json({
        success: true,
        message: 'Video uploaded successfully',
        data: {
          videoUrl
        }
      });
    } catch (error) {
      logger.error('Video upload error:', error);
      next(error);
    }
  }

  public async uploadThumbnail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          success: false,
          message: 'No file uploaded'
        });
        return;
      }

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found'
        });
        return;
      }

      // Upload to S3
      const thumbnailUrl = await this.s3Service.uploadFile(
        file.buffer,
        `thumbnails/${userId}/${projectId}/${file.originalname}`,
        file.mimetype
      );

      // Update project with thumbnail URL
      await Project.findByIdAndUpdate(projectId, {
        thumbnailUrl,
        updatedAt: new Date()
      });

      logger.info(`Thumbnail uploaded for project: ${projectId}, URL: ${thumbnailUrl}`);

      res.json({
        success: true,
        message: 'Thumbnail uploaded successfully',
        data: {
          thumbnailUrl
        }
      });
    } catch (error) {
      logger.error('Thumbnail upload error:', error);
      next(error);
    }
  }
}