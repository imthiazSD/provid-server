import { SQSEvent, SQSRecord } from 'aws-lambda';
import { renderMediaOnLambda, getRenderProgress } from '@remotion/lambda/client';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import axios from 'axios';

// Environment variables
const REMOTION_FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const AWS_REGION = process.env.AWS_REGION_OVERRIDE || process.env.AWS_REGION || 'us-east-1';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const sfnClient = new SFNClient({ region: AWS_REGION });

interface RenderMessage {
  type: string;
  exportId: string;
  projectId: string;
  userId: string;
  renderConfig: {
    compositionId: string;
    inputProps: any;
    codec: 'h264' | 'h265' | 'vp8' | 'vp9' | 'prores';
    webhookUrl?: string;
  };
  timestamp: string;
}

interface RenderAction {
  action: 'start' | 'check' | 'complete' | 'failed';
  exportId: string;
  projectId?: string;
  userId?: string;
  renderConfig?: any;
  renderId?: string;
  bucketName?: string;
  outputUrl?: string;
  error?: any;
}

/**
 * Main Lambda handler - Routes to action handlers or processes SQS events
 */
export const handler = async (event: any): Promise<any> => {
  console.log('Event received:', JSON.stringify(event, null, 2));

  // Check if this is an SQS event
  if (event.Records && Array.isArray(event.Records)) {
    return await handleSQSEvent(event as SQSEvent);
  }

  // Otherwise, it's a Step Functions action
  const action = event as RenderAction;
  
  switch (action.action) {
    case 'start':
      return await startRender(action);
    case 'check':
      return await checkRenderStatus(action);
    case 'complete':
      return await completeRender(action);
    case 'failed':
      return await failRender(action);
    default:
      throw new Error(`Unknown action: ${(action as any).action}`);
  }
};

/**
 * Handle SQS events - Start Step Functions execution
 */
async function handleSQSEvent(event: SQSEvent): Promise<any> {
  console.log(`Processing ${event.Records.length} SQS messages`);

  const results = await Promise.allSettled(
    event.Records.map(record => processSQSRecord(record))
  );

  // Return batch item failures for partial retry
  const batchItemFailures = results
    .map((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Failed to process message ${event.Records[index].messageId}:`, result.reason);
        return { itemIdentifier: event.Records[index].messageId };
      }
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  console.log(`Processed: ${results.length - batchItemFailures.length} succeeded, ${batchItemFailures.length} failed`);

  return { batchItemFailures };
}

/**
 * Process individual SQS record - Trigger Step Functions
 */
async function processSQSRecord(record: SQSRecord): Promise<void> {
  try {
    const message: RenderMessage = JSON.parse(record.body);

    console.log('Starting Step Functions execution for:', {
      exportId: message.exportId,
      projectId: message.projectId,
      compositionId: message.renderConfig.compositionId,
    });

    // Validate required fields
    if (!message.exportId || !message.projectId || !message.userId) {
      throw new Error('Missing required fields: exportId, projectId, or userId');
    }

    if (!STATE_MACHINE_ARN) {
      throw new Error('STATE_MACHINE_ARN environment variable not set');
    }

    // Start Step Functions execution
    const command = new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      input: JSON.stringify({
        exportId: message.exportId,
        projectId: message.projectId,
        userId: message.userId,
        renderConfig: message.renderConfig,
        sqsMessageId: record.messageId,
        timestamp: new Date().toISOString(),
      }),
      name: `render-${message.exportId}-${Date.now()}`,
    });

    const result = await sfnClient.send(command);
    
    console.log('Step Functions execution started:', {
      executionArn: result.executionArn,
      exportId: message.exportId,
    });

    // Update database: export started
    await updateExportInDatabase(message.exportId, {
      status: 'queued',
      executionArn: result.executionArn,
    });

  } catch (error) {
    console.error('Error processing SQS record:', error);
    throw error; // Let SQS retry
  }
}

/**
 * ACTION: Start Render
 * Called by Step Functions to initiate Remotion render
 */
async function startRender(action: RenderAction): Promise<any> {
  try {
    console.log('Starting render:', {
      exportId: action.exportId,
      projectId: action.projectId,
      compositionId: action.renderConfig.compositionId,
    });

    // Validate inputs
    if (!action.renderConfig || !action.renderConfig.compositionId) {
      throw new Error('Missing renderConfig or compositionId');
    }

    // Trigger Remotion Lambda render
    const { renderId, bucketName } = await renderMediaOnLambda({
      region: AWS_REGION as any,
      functionName: REMOTION_FUNCTION_NAME,
      serveUrl: REMOTION_SERVE_URL,
      composition: action.renderConfig.compositionId,
      inputProps: action.renderConfig.inputProps,
      codec: action.renderConfig.codec || 'h264',
      imageFormat: 'jpeg',
      maxRetries: 1,
      privacy: 'public',
      outName: `export-${action.exportId}.mp4`,
      downloadBehavior: { type: 'play-in-browser' },
      framesPerLambda: 100,
    });

    console.log('Render triggered:', { exportId: action.exportId, renderId, bucketName });

    // Update database: render started
    await updateExportInDatabase(action.exportId, {
      status: 'processing',
      renderId,
      bucketName,
    });

    // Send webhook notification
    if (WEBHOOK_URL) {
      await sendWebhook({
        type: 'render_started',
        exportId: action.exportId,
        projectId: action.projectId,
        renderId,
        bucketName,
        timestamp: new Date().toISOString(),
      });
    }

    return {
      success: true,
      renderId,
      bucketName,
      exportId: action.exportId,
    };

  } catch (error: any) {
    console.error('Start render failed:', error);
    
    // Update database: render failed to start
    await updateExportInDatabase(action.exportId, {
      status: 'failed',
      errorMessage: `Failed to start render: ${error.message}`,
    });

    throw error;
  }
}

/**
 * ACTION: Check Render Status
 * Called by Step Functions to poll render progress
 */
async function checkRenderStatus(action: RenderAction): Promise<any> {
  try {
    if (!action.renderId || !action.bucketName) {
      throw new Error('Missing renderId or bucketName');
    }

    console.log('Checking render status:', {
      exportId: action.exportId,
      renderId: action.renderId,
    });

    const progress = await getRenderProgress({
      renderId: action.renderId,
      bucketName: action.bucketName,
      functionName: REMOTION_FUNCTION_NAME,
      region: AWS_REGION as any,
    });

    console.log('Render progress:', {
      exportId: action.exportId,
      progress: progress.overallProgress,
      done: progress.done,
      failed: progress.fatalErrorEncountered,
    });

    // Update database with progress
    if (progress.overallProgress !== undefined) {
      await updateExportInDatabase(action.exportId, {
        progress: progress.overallProgress,
      });
    }

    return {
      done: progress.done,
      failed: progress.fatalErrorEncountered,
      progress: progress.overallProgress,
      outputFile: progress.outputFile,
      outputSizeInBytes: progress.outputSizeInBytes,
      error: progress.errors?.[0] || null,
    };

  } catch (error: any) {
    console.error('Check status failed:', error);

    // Handle throttling gracefully - don't fail, just wait
    if (error.name === 'TooManyRequestsException' || 
        error.name === 'ThrottlingException') {
      console.warn('Throttled by AWS - will retry on next check');
      return {
        done: false,
        failed: false,
        progress: 0,
      };
    }

    // For other errors, re-throw to trigger Step Functions retry
    throw error;
  }
}

/**
 * ACTION: Complete Render
 * Called by Step Functions when render succeeds
 */
async function completeRender(action: RenderAction): Promise<any> {
  try {
    console.log('Completing render:', {
      exportId: action.exportId,
      outputUrl: action.outputUrl,
    });

    // Update database: render completed
    await updateExportInDatabase(action.exportId, {
      status: 'completed',
      outputUrl: action.outputUrl,
      renderId: action.renderId,
      bucketName: action.bucketName,
    });

    // Send webhook notification
    if (WEBHOOK_URL) {
      await sendWebhook({
        type: 'render_success',
        exportId: action.exportId,
        projectId: action.projectId,
        renderId: action.renderId,
        bucketName: action.bucketName,
        outputFile: action.outputUrl,
        timestamp: new Date().toISOString(),
      });
    }

    // Send user notification (email, push, etc.)
    if (action.userId) {
      await sendUserNotification(action.userId, action.exportId, 'completed');
    }

    console.log('Render completed successfully:', action.exportId);

    return {
      success: true,
      exportId: action.exportId,
      outputUrl: action.outputUrl,
    };

  } catch (error) {
    console.error('Complete render failed:', error);
    // Don't throw - we don't want to retry completion
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * ACTION: Fail Render
 * Called by Step Functions when render fails
 */
async function failRender(action: RenderAction): Promise<any> {
  try {
    console.log('Failing render:', {
      exportId: action.exportId,
      error: action.error,
    });

    const errorMessage = action.error?.message || 
                        action.error?.stack || 
                        'Render failed with unknown error';

    // Update database: render failed
    await updateExportInDatabase(action.exportId, {
      status: 'failed',
      errorMessage,
    });

    // Send webhook notification
    if (WEBHOOK_URL) {
      await sendWebhook({
        type: 'render_error',
        exportId: action.exportId,
        projectId: action.projectId,
        errors: [{ message: errorMessage }],
        timestamp: new Date().toISOString(),
      });
    }

    // Send user notification
    if (action.userId) {
      await sendUserNotification(action.userId, action.exportId, 'failed');
    }

    console.log('Render marked as failed:', action.exportId);

    return {
      success: true,
      exportId: action.exportId,
      error: errorMessage,
    };

  } catch (error) {
    console.error('Fail render handler error:', error);
    // Don't throw - we don't want to retry failure handling
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update export status in database
 * TODO: Replace with your actual database calls
 */
async function updateExportInDatabase(exportId: string, updates: any): Promise<void> {
  try {
    console.log('Database update:', { exportId, updates });
    
    // TODO: Implement your database update logic
    // Example with MongoDB:
    // await ExportRequest.findByIdAndUpdate(exportId, updates);
    
    // Example with DynamoDB:
    // const dynamodb = new DynamoDBClient({ region: AWS_REGION });
    // await dynamodb.send(new UpdateItemCommand({ ... }));
    
    // For now, just log
    console.log(`[TODO] Update export ${exportId} with:`, updates);
    
  } catch (error) {
    console.error('Database update failed:', error);
    // Don't throw - database updates shouldn't fail the render
  }
}

/**
 * Send webhook notification
 */
async function sendWebhook(payload: any): Promise<void> {
  if (!WEBHOOK_URL) {
    return;
  }

  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add signature if secret is configured
    if (WEBHOOK_SECRET) {
      const crypto = await import('crypto');
      const signature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-Remotion-Signature'] = signature;
    }

    await axios.post(WEBHOOK_URL, payload, {
      headers,
      timeout: 10000,
    });

    console.log('Webhook sent:', { url: WEBHOOK_URL, type: payload.type });

  } catch (error: any) {
    console.error('Webhook failed:', {
      url: WEBHOOK_URL,
      message: error.message,
      code: error.code,
    });
    // Don't throw - webhook failures shouldn't fail the render
  }
}

/**
 * Send notification to user
 * TODO: Implement your notification logic (email, SMS, push, etc.)
 */
async function sendUserNotification(userId: string, exportId: string, status: string): Promise<void> {
  try {
    console.log('Sending notification:', { userId, exportId, status });
    
    // TODO: Implement your notification service
    // Example with SNS:
    // const sns = new SNSClient({ region: AWS_REGION });
    // await sns.send(new PublishCommand({ ... }));
    
    // Example with SES:
    // const ses = new SESClient({ region: AWS_REGION });
    // await ses.send(new SendEmailCommand({ ... }));
    
    console.log(`[TODO] Send ${status} notification to user ${userId} for export ${exportId}`);
    
  } catch (error) {
    console.error('Notification failed:', error);
    // Don't throw - notification failures shouldn't affect render status
  }
}