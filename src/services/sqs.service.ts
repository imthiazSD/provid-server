import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { logger } from '../utils/logger';

export class SQSService {
  private sqsClient: SQSClient;
  private queueUrl: string;

  constructor() {
    this.sqsClient = new SQSClient({
      region: process.env.AWS_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!
      }
    });
    this.queueUrl = process.env.SQS_QUEUE_URL!;
  }

  public async sendMessage(messageBody: string): Promise<string> {
    try {
      const command = new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: messageBody,
        MessageAttributes: {
          'MessageType': {
            StringValue: 'VideoExport',
            DataType: 'String'
          },
          'Timestamp': {
            StringValue: new Date().toISOString(),
            DataType: 'String'
          }
        }
      });

      const response = await this.sqsClient.send(command);
      logger.info(`Message sent to SQS: ${response.MessageId}`);
      
      return response.MessageId!;
    } catch (error) {
      logger.error('SQS send message error:', error);
      throw new Error('Failed to send message to queue');
    }
  }
}