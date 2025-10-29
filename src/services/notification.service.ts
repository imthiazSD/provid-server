import { logger } from '../utils/logger';
import { IExportRequest } from '../models/export.model';
import { Notification, INotification } from '../models/notification.model';
import { EmailService } from './email.service';
import { User } from '../models/auth.model';

// Get Socket.IO instance from global (set in app.ts)
declare global {
  var io: import('socket.io').Server | undefined;
}

const emailService = new EmailService();

export class NotificationService {
  public async sendExportNotification(
    userId: string,
    exportRequest: IExportRequest,
    status: 'processing' | 'completed' | 'failed'
  ): Promise<void> {
    try {
      const title = this.getNotificationTitle(status);
      const message = this.getNotificationMessage(status, exportRequest);

      const notification: INotification = {
        userId,
        type: 'export_status',
        title,
        message,
        data: {
          exportId: exportRequest._id,
          projectId: exportRequest.projectId,
          status,
          outputUrl: exportRequest.outputUrl,
        },
        read: false,
        timestamp: new Date(),
      };

      // 1. Save to DB
      await Notification.create(notification);
      logger.info('Notification saved to DB', { exportId: exportRequest._id, status });

      // 2. Emit via WebSocket (real-time)
      try {
        const io = global.io;
        if (io) {
          io.to(`user_${userId}`).emit('notification', notification);
          logger.info('WebSocket notification emitted', { userId, exportId: exportRequest._id });
        } else {
          logger.warn('Socket.IO instance not available (global.io missing)');
        }
      } catch (error) {
        logger.warn('Failed to emit WebSocket notification', { userId, error });
      }

      // 3. Send Email
      try {
        const user = await User.findById(userId).select('email name');
        if (user?.email) {
          const emailHtml = this.renderEmailHtml(title, message, exportRequest);
          await emailService.sendEmail({
            to: user.email,
            subject: title,
            html: emailHtml,
            text: message,
          });
          logger.info('Email notification sent', { userId, email: user.email });
        }
      } catch (error) {
        logger.error('Failed to send email notification', { userId, error });
        // Don't break the flow
      }
    } catch (error) {
      logger.error('Send notification error:', {
        error,
        userId,
        exportId: exportRequest._id,
      });
      // Never break render/export flow
    }
  }

  private getNotificationTitle(status: string): string {
    switch (status) {
      case 'processing':
        return 'Video Export Started';
      case 'completed':
        return 'Your Video is Ready!';
      case 'failed':
        return 'Video Export Failed';
      default:
        return 'Video Export Update';
    }
  }

  private getNotificationMessage(status: string, exportRequest: IExportRequest): string {
    switch (status) {
      case 'processing':
        return "Your video is being rendered. Hang tight — we'll notify you when it's ready!";
      case 'completed':
        return `Great news! Your video is ready. Download it now.`;
      case 'failed':
        return `Sorry, your video export failed: ${exportRequest.errorMessage || 'Please try again later.'}`;
      default:
        return 'Your video export status has changed.';
    }
  }

  private renderEmailHtml(title: string, message: string, exportRequest: IExportRequest): string {
    const downloadButton = exportRequest.outputUrl
      ? `<a href="${exportRequest.outputUrl}" style="background:#0066cc;color:white;padding:12px 24px;text-decoration:none;border-radius:6px;display:inline-block;margin:16px 0;font-weight:bold;">Download Video</a>`
      : '';

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>${title}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: auto; padding: 20px; }
            .header { background: #f4f4f4; padding: 24px; text-align: center; border-radius: 8px; margin-bottom: 20px; }
            .content { margin: 20px 0; }
            .button { text-align: center; margin: 24px 0; }
            .footer { font-size: 12px; color: #999; margin-top: 32px; text-align: center; }
          </style>
        </head>
        <body>
          <div class="header">
            <h1>${title}</h1>
          </div>
          <div class="content">
            <p>${message}</p>
            ${exportRequest.outputUrl ? '<p>Click below to download your video:</p>' : ''}
            <div class="button">${downloadButton}</div>
          </div>
          <hr style="border: 1px solid #eee; margin: 32px 0;">
          <div class="footer">
            Export ID: <code>${exportRequest._id}</code><br>
            Project: ${exportRequest.projectId}
          </div>
        </body>
      </html>
    `;
  }
}
