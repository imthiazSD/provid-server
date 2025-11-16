import { SQSClient, SendMessageCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { 
  SFNClient, 
  DescribeExecutionCommand, 
  StopExecutionCommand 
} from '@aws-sdk/client-sfn';
import { logger } from '../utils/logger';

interface RenderRequest {
  exportId: string;
  projectId: string;
  userId: string;
  compositionId: string;
  inputProps: any;
  codec: 'h264' | 'h265' | 'vp8' | 'vp9' | 'prores';
  webhookUrl?: string;
}

export class RemotionSQSService {
  private sqsClient: SQSClient;
  private sfnClient: SFNClient;
  private queueUrl: string;

  constructor() {
    const region = process.env.AWS_REGION || 'us-east-1';
    
    this.sqsClient = new SQSClient({ region });
    this.sfnClient = new SFNClient({ region });
    
    this.queueUrl = process.env.REMOTION_SQS_QUEUE_URL!;

    if (!this.queueUrl) {
      throw new Error('REMOTION_SQS_QUEUE_URL environment variable is required');
    }

    logger.info('RemotionSQSService initialized', {
      region,
      queueUrl: this.queueUrl,
    });
  }

  /**
   * Enqueue a render request to SQS
   * This will trigger Step Functions execution via Lambda
   */
  async enqueueRenderRequest(request: RenderRequest): Promise<string> {
    try {
      const message = {
        type: 'render_request',
        exportId: request.exportId,
        projectId: request.projectId,
        userId: request.userId,
        renderConfig: {
          compositionId: request.compositionId,
          inputProps: request.inputProps,
          codec: request.codec,
          webhookUrl: request.webhookUrl,
        },
        timestamp: new Date().toISOString(),
      };

      const params: any = {
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      };

      // If using FIFO queue, add required attributes
      if (this.queueUrl.endsWith('.fifo')) {
        params.MessageGroupId = 'render-group'; // All renders in same group for serial processing
        params.MessageDeduplicationId = `${request.exportId}-${Date.now()}`; // Prevent duplicates
      }

      logger.info('Sending message to SQS:', {
        exportId: request.exportId,
        queueUrl: this.queueUrl,
        isFifo: this.queueUrl.endsWith('.fifo'),
      });

      const command = new SendMessageCommand(params);
      const response = await this.sqsClient.send(command);

      logger.info('Message sent to SQS:', {
        messageId: response.MessageId,
        exportId: request.exportId,
      });

      return response.MessageId!;
    } catch (error) {
      logger.error('Failed to enqueue render request:', error);
      throw new Error(`Failed to queue render request: ${(error as Error).message}`);
    }
  }

  /**
   * Get queue attributes (for monitoring)
   */
  async getQueueAttributes(): Promise<any> {
    try {
      const command = new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      });

      const response = await this.sqsClient.send(command);
      return response.Attributes;
    } catch (error) {
      logger.error('Failed to get queue attributes:', error);
      throw error;
    }
  }

  /**
   * Get Step Functions execution status
   */
  async getStepFunctionsExecutionStatus(executionArn: string): Promise<any> {
    try {
      const command = new DescribeExecutionCommand({
        executionArn,
      });

      const response = await this.sfnClient.send(command);

      return {
        status: response.status,
        startDate: response.startDate,
        stopDate: response.stopDate,
        input: response.input ? JSON.parse(response.input) : null,
        output: response.output ? JSON.parse(response.output) : null,
        error: response.error,
        cause: response.cause,
      };
    } catch (error) {
      logger.error('Failed to get Step Functions execution status:', error);
      throw error;
    }
  }

  /**
   * Stop a Step Functions execution
   */
  async stopStepFunctionsExecution(executionArn: string, cause: string): Promise<void> {
    try {
      const command = new StopExecutionCommand({
        executionArn,
        cause,
        error: 'UserCancellation',
      });

      await this.sfnClient.send(command);

      logger.info('Step Functions execution stopped:', {
        executionArn,
        cause,
      });
    } catch (error) {
      logger.error('Failed to stop Step Functions execution:', error);
      throw error;
    }
  }

  /**
   * Health check - verify SQS connection
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getQueueAttributes();
      return true;
    } catch (error) {
      logger.error('SQS health check failed:', error);
      return false;
    }
  }
}