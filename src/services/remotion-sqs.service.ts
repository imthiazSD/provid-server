import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  renderMediaOnLambda,
  getRenderProgress,
  AwsRegion,
} from "@remotion/lambda/client";
import { logger } from "../utils/logger";

export class RemotionSQSService {
  private sqsClient: SQSClient;
  private queueUrl: string;
  private region: AwsRegion;

  constructor() {
    this.region = (process.env.AWS_REGION || "us-east-1") as AwsRegion;
    this.queueUrl = process.env.REMOTION_SQS_QUEUE_URL!;
    if (!this.queueUrl) {
      throw new Error("REMOTION_SQS_QUEUE_URL is not set");
    }

    this.sqsClient = new SQSClient({
      region: this.region,
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined, // Use default credential provider if not set
    });
  }

  /**
   * Send render request to SQS queue
   * The Lambda function will pick this up and call renderMediaOnLambda
   */
  public async enqueueRenderRequest(params: {
    exportId: string;
    projectId: string;
    userId: string;
    compositionId: string;
    inputProps: any;
    codec?: "h264" | "h265" | "vp8" | "vp9" | "prores";
    webhookUrl?: string;
  }): Promise<string> {
    try {
      const messageBody = {
        type: "RENDER_VIDEO",
        exportId: params.exportId,
        projectId: params.projectId,
        userId: params.userId,
        renderConfig: {
          compositionId: params.compositionId,
          inputProps: params.inputProps,
          codec: params.codec || "h264",
          webhookUrl: params.webhookUrl,
        },
        timestamp: new Date().toISOString(),
      };

      const command = new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(messageBody),
        MessageAttributes: {
          MessageType: {
            StringValue: "RENDER_VIDEO",
            DataType: "String",
          },
          ExportId: {
            StringValue: params.exportId,
            DataType: "String",
          },
          Timestamp: {
            StringValue: new Date().toISOString(),
            DataType: "String",
          },
        },
      });

      const response = await this.sqsClient.send(command);
      logger.info(`Render request queued to SQS: ${response.MessageId}`);
      return response.MessageId!;
    } catch (error: any) {
      logger.error("Failed to enqueue render request:", {
        error: error.message,
        code: error.code,
        stack: error.stack,
        queueUrl: this.queueUrl,
        exportId: params.exportId,
        projectId: params.projectId,
      });
      throw new Error(
        `Failed to queue render request: ${error.message} (Code: ${error.code})`
      );
    }
  }

  /**
   * Get render progress from Remotion Lambda
   * This is called after the Lambda function has started rendering
   */
  public async getRenderProgress(renderId: string, bucketName: string) {
    try {
      const functionName = process.env.REMOTION_LAMBDA_FUNCTION_NAME!;
      if (!functionName) {
        throw new Error("REMOTION_LAMBDA_FUNCTION_NAME is not set");
      }

      const progress = await getRenderProgress({
        renderId,
        bucketName,
        functionName,
        region: this.region,
      });

      return {
        done: progress.done,
        overallProgress: progress.overallProgress,
        outputFile: progress.outputFile,
        outputSizeInBytes: progress.outputSizeInBytes,
        errors: progress.errors,
        fatalErrorEncountered: progress.fatalErrorEncountered,
        currentTime: progress.currentTime,
        renderMetadata: progress.renderMetadata,
      };
    } catch (error: any) {
      logger.error("Failed to get render progress:", {
        error: error.message,
        code: error.code,
        stack: error.stack,
        renderId,
        bucketName,
      });
      throw error;
    }
  }
}
