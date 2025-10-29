import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { logger } from '../utils/logger';

const sesClient = new SESClient({
  region: process.env.AWS_REGION || 'us-east-1',
});

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export class EmailService {
  public async sendEmail({ to, subject, html, text }: EmailOptions): Promise<void> {
    const params = {
      Source: process.env.EMAIL_FROM!,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: html, Charset: 'UTF-8' },
          Text: text ? { Data: text, Charset: 'UTF-8' } : undefined,
        },
      },
    };

    try {
      const command = new SendEmailCommand(params);
      await sesClient.send(command);
      logger.info('Email sent successfully', { to, subject });
    } catch (error) {
      logger.error('Failed to send email', { error, to, subject });
      throw error; // Let caller handle
    }
  }
}
