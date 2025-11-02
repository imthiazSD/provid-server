import { SQSEvent, SQSRecord } from 'aws-lambda';
import { renderMediaOnLambda } from '@remotion/lambda/client';
import axios from 'axios';

// Environment variables
const REMOTION_FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const AWS_REGION = process.env.AWS_REGION! || 'us-east-1';
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

  const results = await Promise.allSettled(event.Records.map(record => processRecord(record)));

  // Return batch item failures for SQS FIFO/partial retry
  const batchItemFailures = results
    .map((result, index) => {
      if (result.status === 'rejected') {
        return { itemIdentifier: event.Records[index].messageId };
      }
      return null;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return { batchItemFailures };
};

async function processRecord(record: SQSRecord): Promise<void> {
  let message: RenderMessage;
  let webhookUrl: URL | undefined;

  try {
    message = JSON.parse(record.body);

    console.log('Processing render request:', {
      exportId: message.exportId,
      projectId: message.projectId,
      compositionId: message.renderConfig.compositionId,
    });

    // Validate and parse webhook URL
    if (message.renderConfig.webhookUrl) {
      try {
        webhookUrl = new URL(message.renderConfig.webhookUrl);
        console.log('Valid webhook URL:', webhookUrl.toString());
      } catch (err) {
        console.warn('Invalid webhook URL, skipping:', message.renderConfig.webhookUrl);
        webhookUrl = undefined;
      }
    }

    // Notify webhook: render started
    if (webhookUrl) {
      await sendWebhook(webhookUrl, {
        type: 'render_started',
        exportId: message.exportId,
        projectId: message.projectId,
        timestamp: new Date().toISOString(),
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
      downloadBehavior: { type: 'play-in-browser' },
      // Optional: Use Remotion webhook instead of polling
      // webhook: { url: "https://yourdomain.com/api/remotion-webhook", secret: WEBHOOK_SECRET },
    });

    console.log('Render triggered:', { exportId: message.exportId, renderId, bucketName });

    // Poll for completion
    // await pollRenderStatus(renderId, bucketName, message.exportId, webhookUrl);
  } catch (error) {
    console.error('Error processing record:', error);

    // Try to send error webhook
    try {
      if (!message) message = JSON.parse(record.body);
      if (webhookUrl) {
        await sendWebhook(webhookUrl, {
          type: 'render_error',
          exportId: message.exportId,
          errors: [
            {
              message: error instanceof Error ? error.message : 'Unknown error',
              stack: error instanceof Error ? error.stack : undefined,
            },
          ],
          timestamp: new Date().toISOString(),
        });
      }
    } catch (webhookError) {
      console.error('Failed to send error webhook:', webhookError);
    }

    throw error; // Let SQS retry
  }
}

async function pollRenderStatus(
  renderId: string,
  bucketName: string,
  exportId: string,
  webhookUrl?: URL
): Promise<void> {
  const { getRenderProgress } = await import('@remotion/lambda/client');

  const maxAttempts = 120; // ~10 minutes
  let attempts = 0;
  let delayMs = 5000; // Start at 5s

  while (attempts < maxAttempts) {
    try {
      const progress = await getRenderProgress({
        renderId,
        bucketName,
        functionName: REMOTION_FUNCTION_NAME,
        region: AWS_REGION as any,
      });

      console.log('Render progress:', {
        exportId,
        progress: progress.overallProgress,
        done: progress.done,
        fatalError: progress.fatalErrorEncountered,
      });

      if (progress.done) {
        if (webhookUrl) {
          await sendWebhook(webhookUrl, {
            type: 'render_success',
            exportId,
            renderId,
            bucketName,
            outputFile: progress.outputFile,
            outputSizeInBytes: progress.outputSizeInBytes,
            timestamp: new Date().toISOString(),
          });
        }
        console.log('Render completed:', { exportId, outputFile: progress.outputFile });
        return;
      }

      if (progress.fatalErrorEncountered) {
        if (webhookUrl) {
          await sendWebhook(webhookUrl, {
            type: 'render_error',
            exportId,
            renderId,
            bucketName,
            errors: progress.errors,
            timestamp: new Date().toISOString(),
          });
        }
        throw new Error('Render failed with fatal error');
      }

      // Reset delay on success
      delayMs = 5000;
    } catch (error: any) {
      console.error('Error in getRenderProgress:', {
        name: error.name,
        message: error.message,
        reason: error.Reason,
        statusCode: error.$metadata?.httpStatusCode,
      });

      // Handle throttling: ConcurrentInvocationLimitExceeded
      const isThrottled =
        error.name === 'TooManyRequestsException' &&
        error.Reason === 'ConcurrentInvocationLimitExceeded';

      if (isThrottled) {
        console.warn(`Throttled. Backing off to ${delayMs / 1000}s...`);
        delayMs = Math.min(delayMs * 2, 60000); // Exponential backoff, max 60s
      } else {
        // For non-throttling errors, throw to fail fast
        throw error;
      }
    }

    // Wait before next attempt
    await new Promise(resolve => setTimeout(resolve, delayMs));
    attempts++;
  }

  // Timeout
  if (webhookUrl) {
    await sendWebhook(webhookUrl, {
      type: 'render_timeout',
      exportId,
      renderId,
      bucketName,
      timestamp: new Date().toISOString(),
    });
  }

  throw new Error('Render timed out after 10 minutes');
}

async function sendWebhook(url: URL, payload: any): Promise<void> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (WEBHOOK_SECRET) {
      const crypto = await import('crypto');
      const signature = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-Remotion-Signature'] = signature;
    }

    await axios.post(url.toString(), payload, {
      headers,
      timeout: 10000,
    });

    console.log('Webhook sent:', { url: url.toString(), type: payload.type });
  } catch (error: any) {
    console.error('Webhook failed:', {
      url: url.toString(),
      message: error.message,
      code: error.code,
    });
    // Don't throw — webhook failure shouldn't fail render
  }
}
