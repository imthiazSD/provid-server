import { Request, Response, NextFunction } from 'express';
import { S3Service } from '../services/s3.service';
import { Project } from '../models/project.model';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { Readable } from 'stream';

export class UploadController {
  private s3Service: S3Service;

  constructor() {
    this.s3Service = new S3Service();
  }

  /**
   * Generate unique filename with original extension
   */
  private generateUniqueFileName(originalName: string): string {
    const ext = path.extname(originalName);
    const timestamp = Date.now();
    const uniqueId = uuidv4();
    return `${timestamp}-${uniqueId}${ext}`;
  }

  /**
   * Sanitize filename to remove special characters
   */
  private sanitizeFileName(fileName: string): string {
    return fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  }

  /**
   * Get file size in MB
   */
  private getFileSizeMB(bytes: number): string {
    return (bytes / (1024 * 1024)).toFixed(2);
  }

  // controllers/videoUploadController.ts

  public async generatePresignedUrl(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const startTime = Date.now();
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const { fileName, fileType, fileSize } = req.body;

      logger.info(
        `Presigned URL request - ProjectId: ${projectId}, UserId: ${userId}, File: ${fileName}`
      );

      // Validate inputs
      if (!fileName || !fileType || !fileSize) {
        res
          .status(400)
          .json({ success: false, message: 'fileName, fileType, and fileSize are required' });
        return;
      }

      // Validate file type
      const allowedVideoTypes = [
        'video/mp4',
        'video/mpeg',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'video/x-matroska',
      ];

      if (!allowedVideoTypes.includes(fileType)) {
        res.status(400).json({
          success: false,
          message: `Invalid file type: ${fileType}. Allowed: ${allowedVideoTypes.join(', ')}`,
        });
        return;
      }

      // Max size: 500MB
      const maxSize = 500 * 1024 * 1024;
      if (fileSize > maxSize) {
        res.status(400).json({
          success: false,
          message: `File too large. Max: 500MB`,
        });
        return;
      }

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        logger.warn(`Project not found - ProjectId: ${projectId}, UserId: ${userId}`);
        res.status(404).json({ success: false, message: 'Project not found or access denied' });
        return;
      }

      // Generate unique filename
      const uniqueFileName = this.generateUniqueFileName(fileName);
      const s3Key = `videos/${userId}/${projectId}/${uniqueFileName}`;

      // Generate presigned URL (valid for 15 minutes)
      const presignedUrl = await this.s3Service.generatePresignedUrl(
        s3Key,
        fileType,
        fileSize,
        15 * 60 // 15 minutes
      );

      const videoUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${s3Key}`;

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`Presigned URL generated - ProjectId: ${projectId}, Time: ${totalTime}s`);

      res.json({
        success: true,
        data: {
          presignedUrl,
          videoUrl,
          s3Key,
          fileName: uniqueFileName,
        },
      });
    } catch (error: any) {
      logger.error('Presigned URL generation failed:', error);
      next(error);
    }
  }

  public async completeVideoUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const { videoUrl } = req.body;

      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({ success: false, message: 'Project not found' });
        return;
      }

      // Delete old video (fire and forget)
      if (project.compositionSettings?.videoUrl) {
        this.s3Service.deleteFileFromUrl(project.compositionSettings.videoUrl).catch(() => {});
      }

      // Update project
      await Project.findByIdAndUpdate(projectId, {
        'compositionSettings.videoUrl': videoUrl,
        updatedAt: new Date(),
      });

      res.json({
        success: true,
        message: 'Video linked to project',
        data: { videoUrl },
      });
    } catch (error: any) {
      next(error);
    }
  }

  public async uploadVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
    const startTime = Date.now();

    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;
      const file = req.file;

      logger.info(`Upload request received - ProjectId: ${projectId}, UserId: ${userId}`);

      if (!file) {
        res.status(400).json({
          success: false,
          message: 'No file uploaded',
        });
        return;
      }

      logger.info(
        `File details - Name: ${file.originalname}, Size: ${this.getFileSizeMB(
          file.size
        )}MB, Type: ${file.mimetype}`
      );

      // Validate file type
      const allowedVideoTypes = [
        'video/mp4',
        'video/mpeg',
        'video/quicktime',
        'video/x-msvideo',
        'video/webm',
        'video/x-matroska', // .mkv
      ];

      if (!allowedVideoTypes.includes(file.mimetype)) {
        res.status(400).json({
          success: false,
          message: `Invalid file type: ${
            file.mimetype
          }. Allowed types: ${allowedVideoTypes.join(', ')}`,
        });
        return;
      }

      // Check file size (max 500MB)
      const maxSize = 500 * 1024 * 1024; // 500MB
      if (file.size > maxSize) {
        res.status(400).json({
          success: false,
          message: `File too large. Maximum size is ${this.getFileSizeMB(maxSize)}MB`,
        });
        return;
      }

      // Verify project ownership
      logger.info(`Verifying project ownership - ProjectId: ${projectId}`);
      const project = await Project.findOne({ _id: projectId, userId });

      if (!project) {
        logger.warn(
          `Project not found or access denied - ProjectId: ${projectId}, UserId: ${userId}`
        );
        res.status(404).json({
          success: false,
          message: 'Project not found or access denied',
        });
        return;
      }

      // Generate unique filename
      const uniqueFileName = this.generateUniqueFileName(file.originalname);
      const s3Key = `videos/${userId}/${projectId}/${uniqueFileName}`;

      logger.info(`Starting S3 upload - Key: ${s3Key}, Size: ${this.getFileSizeMB(file.size)}MB`);

      // Upload to S3 with streaming for better performance
      const videoUrl = await this.s3Service.uploadFileStream(
        file.buffer,
        s3Key,
        file.mimetype,
        true, // Make file publicly accessible
        progress => {
          // Log progress every 10%
          if (progress % 10 === 0) {
            logger.info(`Upload progress for ${projectId}: ${progress}%`);
          }
        }
      );

      const uploadTime = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`S3 upload completed - URL: ${videoUrl}, Time: ${uploadTime}s`);

      // Delete old video if exists (async, don't wait)
      if (project.compositionSettings?.videoUrl) {
        this.s3Service
          .deleteFileFromUrl(project.compositionSettings.videoUrl)
          .then(() => logger.info(`Deleted old video for project: ${projectId}`))
          .catch(error => logger.warn(`Failed to delete old video: ${error.message}`));
      }

      // Update project with video URL
      logger.info(`Updating project with new video URL - ProjectId: ${projectId}`);
      await Project.findByIdAndUpdate(projectId, {
        'compositionSettings.videoUrl': videoUrl,
        updatedAt: new Date(),
      });

      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(
        `Video upload completed successfully - ProjectId: ${projectId}, Total time: ${totalTime}s`
      );

      res.json({
        success: true,
        message: 'Video uploaded successfully',
        data: {
          videoUrl,
          fileName: uniqueFileName,
          fileSize: file.size,
          fileSizeMB: this.getFileSizeMB(file.size),
          mimeType: file.mimetype,
          uploadTimeSeconds: parseFloat(totalTime),
        },
      });
    } catch (error: any) {
      const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.error(`Video upload failed after ${totalTime}s:`, {
        error: error.message,
        stack: error.stack,
        projectId: req.params.projectId,
      });

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
          message: 'No file uploaded',
        });
        return;
      }

      // Validate file type
      const allowedImageTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

      if (!allowedImageTypes.includes(file.mimetype)) {
        res.status(400).json({
          success: false,
          message: 'Invalid file type. Only image files are allowed.',
        });
        return;
      }

      // Check file size (max 10MB for thumbnails)
      const maxSize = 10 * 1024 * 1024; // 10MB
      if (file.size > maxSize) {
        res.status(400).json({
          success: false,
          message: `File too large. Maximum size is ${this.getFileSizeMB(maxSize)}MB`,
        });
        return;
      }

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found',
        });
        return;
      }

      // Generate unique filename
      const uniqueFileName = this.generateUniqueFileName(file.originalname);
      const s3Key = `thumbnails/${userId}/${projectId}/${uniqueFileName}`;

      logger.info(`Uploading thumbnail: ${s3Key}`);

      // Upload to S3 with public-read ACL
      const thumbnailUrl = await this.s3Service.uploadFile(
        file.buffer,
        s3Key,
        file.mimetype,
        true // Make file publicly accessible
      );

      // Delete old thumbnail if exists (async)
      if (project.thumbnailUrl) {
        this.s3Service
          .deleteFileFromUrl(project.thumbnailUrl)
          .then(() => logger.info(`Deleted old thumbnail for project: ${projectId}`))
          .catch(error => logger.warn(`Failed to delete old thumbnail: ${error.message}`));
      }

      // Update project with thumbnail URL
      await Project.findByIdAndUpdate(projectId, {
        thumbnailUrl,
        updatedAt: new Date(),
      });

      logger.info(`Thumbnail uploaded successfully for project: ${projectId}`);

      res.json({
        success: true,
        message: 'Thumbnail uploaded successfully',
        data: {
          thumbnailUrl,
          fileName: uniqueFileName,
          fileSize: file.size,
          fileSizeMB: this.getFileSizeMB(file.size),
          mimeType: file.mimetype,
        },
      });
    } catch (error) {
      logger.error('Thumbnail upload error:', error);
      next(error);
    }
  }

  /**
   * Delete uploaded video
   */
  public async deleteVideo(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = (req as any).userId;
      const { projectId } = req.params;

      // Verify project ownership
      const project = await Project.findOne({ _id: projectId, userId });
      if (!project) {
        res.status(404).json({
          success: false,
          message: 'Project not found',
        });
        return;
      }

      if (!project.compositionSettings?.videoUrl) {
        res.status(404).json({
          success: false,
          message: 'No video found for this project',
        });
        return;
      }

      // Delete from S3
      await this.s3Service.deleteFileFromUrl(project.compositionSettings.videoUrl);

      // Remove video URL from project
      await Project.findByIdAndUpdate(projectId, {
        'compositionSettings.videoUrl': null,
        updatedAt: new Date(),
      });

      logger.info(`Video deleted for project: ${projectId}`);

      res.json({
        success: true,
        message: 'Video deleted successfully',
      });
    } catch (error) {
      logger.error('Video deletion error:', error);
      next(error);
    }
  }

  /**
   * Health check endpoint to verify upload service is working
   */
  public async healthCheck(req: Request, res: Response): Promise<void> {
    try {
      const isS3Connected = await this.s3Service.testConnection();

      res.json({
        success: true,
        message: 'Upload service is healthy',
        data: {
          s3Connected: isS3Connected,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      res.status(503).json({
        success: false,
        message: 'Upload service is unhealthy',
        error: error.message,
      });
    }
  }
}
