import { SQSEvent, SQSRecord } from 'aws-lambda';
import { renderMediaOnLambda } from '@remotion/lambda/client';
import axios from 'axios';

// Environment variables
const REMOTION_FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const AWS_REGION = process.env.AWS_REGION!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

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

/**
 * Lambda function that processes SQS messages and triggers Remotion renders
 */
export const handler = async (event: SQSEvent): Promise<any> => {
  console.log('Received SQS event:', JSON.stringify(event, null, 2));

  const results = await Promise.allSettled(
    event.Records.map((record) => processRecord(record))
  );

  // Return batch item failures for SQS to retry
  const batchItemFailures = results
    .map((result, index) => {
      if (result.status === 'rejected') {
        return { itemIdentifier: event.Records[index].messageId };
      }
      return null;
    })
    .filter((item) => item !== null);

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  try {
    const message: RenderMessage = JSON.parse(record.body);
    
    console.log('Processing render request:', {
      exportId: message.exportId,
      projectId: message.projectId,
      compositionId: message.renderConfig.compositionId
    });

    // Notify webhook that rendering has started
    if (message.renderConfig.webhookUrl) {
      await sendWebhook(message.renderConfig.webhookUrl, {
        type: 'render_started',
        exportId: message.exportId,
        projectId: message.projectId,
        timestamp: new Date().toISOString()
      });
    }

    // Trigger Remotion Lambda render
    const { renderId, bucketName } = await renderMediaOnLambda({
      region: AWS_REGION as any,
      functionName: REMOTION_FUNCTION_NAME,
      serveUrl: REMOTION_SERVE_URL,
      composition: message.renderConfig.compositionId,
      inputProps: message.renderConfig.inputProps,
      codec: message.renderConfig.codec,
      imageFormat: 'jpeg',
      maxRetries: 1,
      privacy: 'public',
      outName: `export-${message.exportId}.mp4`,
      downloadBehavior: {
        type: 'play-in-browser'
      }
    });

    console.log('Render triggered successfully:', {
      exportId: message.exportId,
      renderId,
      bucketName
    });

    // Poll for render completion
    await pollRenderStatus(
      renderId,
      bucketName,
      message.exportId,
      message.renderConfig.webhookUrl
    );

  } catch (error) {
    console.error('Error processing record:', error);
    
    // Try to notify webhook of failure
    try {
      const message: RenderMessage = JSON.parse(record.body);
      if (message.renderConfig.webhookUrl) {
        await sendWebhook(message.renderConfig.webhookUrl, {
          type: 'render_error',
          exportId: message.exportId,
          errors: [{
            message: error instanceof Error ? error.message : 'Unknown error',
            stack: error instanceof Error ? error.stack : undefined
          }],
          timestamp: new Date().toISOString()
        });
      }
    } catch (webhookError) {
      console.error('Failed to send error webhook:', webhookError);
    }
    
    throw error; // Re-throw to mark as failed in SQS
  }
}

async function pollRenderStatus(
  renderId: string,
  bucketName: string,
  exportId: string,
  webhookUrl?: string
): Promise<void> {
  const { getRenderProgress } = await import('@remotion/lambda/client');
  
  const maxAttempts = 120; // 10 minutes (5 second intervals)
  let attempts = 0;

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
    
    try {
      const progress = await getRenderProgress({
        renderId,
        bucketName,
        functionName: REMOTION_FUNCTION_NAME,
        region: AWS_REGION as any
      });

      console.log('Render progress:', {
        exportId,
        progress: progress.overallProgress,
        done: progress.done
      });

      if (progress.done) {
        // Render completed successfully
        if (webhookUrl) {
          await sendWebhook(webhookUrl, {
            type: 'render_success',
            exportId,
            renderId,
            bucketName,
            outputFile: progress.outputFile,
            outputSizeInBytes: progress.outputSizeInBytes,
            timestamp: new Date().toISOString()
          });
        }
        
        console.log('Render completed successfully:', {
          exportId,
          outputFile: progress.outputFile
        });
        
        return;
      }

      if (progress.fatalErrorEncountered) {
        // Render failed
        if (webhookUrl) {
          await sendWebhook(webhookUrl, {
            type: 'render_error',
            exportId,
            renderId,
            bucketName,
            errors: progress.errors,
            timestamp: new Date().toISOString()
          });
        }
        
        throw new Error('Render failed with fatal error');
      }

    } catch (error) {
      console.error('Error checking render progress:', error);
      throw error;
    }

    attempts++;
  }

  // Timeout
  if (webhookUrl) {
    await sendWebhook(webhookUrl, {
      type: 'render_timeout',
      exportId,
      renderId,
      bucketName,
      timestamp: new Date().toISOString()
    });
  }

  throw new Error('Render timeout');
}

async function sendWebhook(url: string, payload: any): Promise<void> {
  try {
    const headers: any = {
      'Content-Type': 'application/json'
    };

    // Add signature if webhook secret is configured
    if (WEBHOOK_SECRET) {
      const crypto = await import('crypto');
      const signature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
      
      headers['X-Remotion-Signature'] = signature;
    }

    await axios.post(url, payload, {
      headers,
      timeout: 10000 // 10 second timeout
    });

    console.log('Webhook sent successfully:', { url, type: payload.type });
  } catch (error) {
    console.error('Failed to send webhook:', error);
    // Don't throw - webhook failures shouldn't fail the render
  }
}