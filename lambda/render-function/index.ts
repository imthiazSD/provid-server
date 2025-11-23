import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { renderMediaOnLambda } from '@remotion/lambda-client';
import axios from 'axios';

// === Environment ===
const REMOTION_FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const AWS_REGION = process.env.AWS_REGION_OVERRIDE || 'us-east-1';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const API_BASE_URL = process.env.API_BASE_URL; // Your backend API URL
const API_SECRET_KEY = process.env.API_SECRET_KEY; // For authenticating Lambda -> API calls

const sfnClient = new SFNClient({ region: AWS_REGION });

// === Types (Based on Remotion Documentation) ===
interface RenderAction {
  action: 'start';
  exportId: string;
  projectId: string;
  userId: string;
  renderConfig: {
    compositionId: string;
    inputProps: any;
    codec?: string;
  };
  taskToken?: string;
}

// Remotion Webhook Payload Types (from official docs)
interface StaticWebhookPayload {
  renderId: string;
  expectedBucketOwner: string;
  bucketName: string;
  customData: Record<string, unknown> | null;
}

interface WebhookErrorPayload extends StaticWebhookPayload {
  type: 'error';
  errors: {
    message: string;
    name: string;
    stack: string;
  }[];
}

interface WebhookSuccessPayload extends StaticWebhookPayload {
  type: 'success';
  lambdaErrors: any[];
  outputUrl?: string;
  outputFile?: string;
  timeToFinish?: number;
  costs: {
    estimatedCost: number;
    currency: string;
    disclaimer: string;
  };
}

interface WebhookTimeoutPayload extends StaticWebhookPayload {
  type: 'timeout';
}

type RemotionWebhookPayload = WebhookErrorPayload | WebhookSuccessPayload | WebhookTimeoutPayload;

// === Main Handler ===
export const handler = async (event: any): Promise<any> => {
  const log = (...args: any[]) => console.log(`[WORKER] ${new Date().toISOString()} |`, ...args);

  log('Lambda invoked');
  log('Event received:');
  log(JSON.stringify(event, null, 2));

  // Check if this is an HTTP webhook call (from Remotion)
  if (event.requestContext && event.requestContext.http) {
    log('Detected HTTP webhook request from Remotion');
    return await handleRemotionWebhook(event, log);
  }

  // Otherwise, it's a Step Functions invocation
  const action = event as RenderAction;

  try {
    if (action.action === 'start') {
      log('Action: start render');
      return await startRender(action, log);
    } else {
      log(`Unknown action: ${action.action}`);
      throw new Error(`Unknown action: ${action.action}`);
    }
  } catch (error: any) {
    log('ERROR:');
    log(error);

    // Update database on error
    if (action.exportId) {
      await updateExportInDatabase(action.exportId, {
        status: 'failed',
        errorMessage: error.message || 'Unknown error',
      }).catch(err => log('Failed to update DB on error:', err));
    }

    // If there's a taskToken, notify Step Functions of failure
    if (action.taskToken) {
      try {
        const cmd = new SendTaskFailureCommand({
          taskToken: action.taskToken,
          error: 'RenderFailed',
          cause: error.message || 'Unknown error',
        });
        await sfnClient.send(cmd);
        log('Notified Step Functions of failure');
      } catch (sfnError) {
        log('Failed to notify Step Functions:', sfnError);
      }
    }

    throw error;
  }
};

// === Handle Remotion Webhook (HTTP) ===
async function handleRemotionWebhook(event: any, log: (...args: any[]) => void): Promise<any> {
  try {
    log('Processing Remotion webhook...');

    // Get the body (might be base64 encoded)
    let bodyString: string;
    if (event.isBase64Encoded) {
      log('Body is base64 encoded');
      bodyString = Buffer.from(event.body, 'base64').toString('utf-8');
    } else {
      bodyString = event.body || '{}';
    }

    log('Raw body length:', bodyString.length);
    log('Headers:', JSON.stringify(event.headers, null, 2));

    // Parse the Remotion payload
    let payload: RemotionWebhookPayload;
    try {
      payload = JSON.parse(bodyString);
      log('Parsed Remotion payload successfully');
      log('Payload type:', payload.type);
    } catch (parseError: any) {
      log('Failed to parse JSON:', parseError.message);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON payload', details: parseError.message }),
      };
    }

    // Verify signature if secret is set
    if (WEBHOOK_SECRET) {
      const signature =
        event.headers['x-remotion-signature'] || event.headers['X-Remotion-Signature'];

      if (!signature || signature === 'NO_SECRET_PROVIDED') {
        log('WARNING: No valid signature provided');
      } else {
        const crypto = await import('crypto');
        const expectedSignature =
          'sha512=' + crypto.createHmac('sha512', WEBHOOK_SECRET).update(bodyString).digest('hex');

        if (signature !== expectedSignature) {
          log('ERROR: Signature mismatch');
          return {
            statusCode: 401,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Invalid signature' }),
          };
        }
        log('Signature verified successfully');
      }
    }

    log('Remotion webhook payload:');
    log(JSON.stringify(payload, null, 2));

    // Extract fields from Remotion payload
    const { type, renderId, bucketName, customData } = payload;

    log('CustomData received:', JSON.stringify(customData, null, 2));

    // Extract our custom data
    const taskToken = customData?.taskToken as string | undefined;
    const exportId = customData?.exportId as string | undefined;
    const projectId = customData?.projectId as string | undefined;
    const userId = customData?.userId as string | undefined;

    if (!taskToken || !exportId) {
      log('ERROR: Missing required customData fields (taskToken or exportId)');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Missing required fields in customData',
          received: customData,
        }),
      };
    }

    // Validate taskToken format
    if (typeof taskToken !== 'string' || taskToken.length < 100) {
      log('ERROR: Invalid taskToken format');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid taskToken format',
          hint: 'Token should be a long base64 string',
        }),
      };
    }

    const isSuccess = type === 'success';
    const isTimeout = type === 'timeout';
    log(`Render result: ${type} (renderId: ${renderId})`);

    // Construct output URL from Remotion's S3 bucket
    // Remotion stores files in their own S3 bucket with the outputFile key
    let outputUrl: string | undefined;
    let estimatedCost: number | undefined;

    if (isSuccess && 'outputFile' in payload && payload.outputFile) {
      // Remotion's S3 URL structure
      outputUrl = `https://${bucketName}.s3.${AWS_REGION}.amazonaws.com/${payload.outputFile}`;
      log('Output URL constructed:', outputUrl);

      // Extract cost information
      if ('costs' in payload && payload.costs) {
        estimatedCost = payload.costs.estimatedCost;
        log('Estimated cost:', estimatedCost, payload.costs.currency);
      }
    }

    // === Update Database ===
    if (exportId) {
      try {
        let dbUpdate: any;

        if (isSuccess) {
          dbUpdate = {
            status: 'completed',
            renderId,
            bucketName,
            outputUrl,
            estimatedCost,
            progress: 100,
          };
        } else if (isTimeout) {
          dbUpdate = {
            status: 'failed',
            errorMessage: 'Render timed out',
          };
        } else {
          // Error case
          const errorPayload = payload as WebhookErrorPayload;
          const errorMessage = errorPayload.errors?.[0]?.message || 'Render failed';
          dbUpdate = {
            status: 'failed',
            errorMessage,
          };
        }

        log('Updating database:', { exportId, ...dbUpdate });
        await updateExportInDatabase(exportId, dbUpdate);
        log('Database updated successfully');
      } catch (dbError: any) {
        log('Database update error:', dbError.message);
        // Continue even if DB update fails
      }
    }

    // === Send Notifications ===
    if (exportId && userId) {
      try {
        const notificationStatus = isSuccess ? 'completed' : 'failed';
        const errorMessage = isTimeout
          ? 'Render timed out'
          : type === 'error'
            ? (payload as WebhookErrorPayload).errors?.[0]?.message
            : undefined;

        log('Sending notification:', { exportId, userId, status: notificationStatus });

        await sendUserNotification(
          userId,
          exportId,
          projectId || '',
          notificationStatus,
          outputUrl,
          errorMessage
        );

        log('Notification sent successfully');
      } catch (notifError: any) {
        log('Notification error:', notifError.message);
        // Continue even if notification fails
      }
    }

    // === Send to Step Functions ===
    try {
      let cmd;

      if (isSuccess) {
        const successPayload = payload as WebhookSuccessPayload;
        cmd = new SendTaskSuccessCommand({
          taskToken,
          output: JSON.stringify({
            success: true,
            renderId,
            bucketName,
            outputFile: successPayload.outputFile,
            outputUrl,
            timeToFinish: successPayload.timeToFinish,
          }),
        });
      } else {
        // Error or timeout
        const errorMessage = isTimeout
          ? 'Render timed out'
          : (payload as WebhookErrorPayload).errors?.[0]?.message || 'Render failed';

        cmd = new SendTaskFailureCommand({
          taskToken,
          error: isTimeout ? 'RenderTimeout' : 'RenderFailed',
          cause: errorMessage,
        });
      }

      await sfnClient.send(cmd as any);
      log(`Step Functions notified: ${isSuccess ? 'success' : 'failure'}`);
    } catch (sfnError: any) {
      log('Step Functions error:');
      log('Error name:', sfnError.name);
      log('Error message:', sfnError.message);
      throw sfnError;
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Webhook processed' }),
    };
  } catch (error: any) {
    log('Webhook processing error:');
    log('Error:', error.message);
    log('Stack:', error.stack);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    };
  }
}

// === Start Render ===
async function startRender(action: RenderAction, log: (...args: any[]) => void): Promise<any> {
  log('Starting renderMediaOnLambda...');

  const taskToken = action.taskToken;
  log('TaskToken from action:', {
    type: typeof taskToken,
    length: taskToken?.length,
    preview: taskToken?.substring(0, 100) + '...',
  });

  log({
    functionName: REMOTION_FUNCTION_NAME,
    serveUrl: REMOTION_SERVE_URL,
    composition: action.renderConfig.compositionId,
    exportId: action.exportId,
    webhookUrl: WEBHOOK_URL,
    hasTaskToken: !!taskToken,
  });

  // Update status to processing before starting
  if (action.exportId) {
    await updateExportInDatabase(action.exportId, {
      status: 'processing',
      progress: 5,
    }).catch(err => log('Failed to update DB before render:', err));

    // Send processing notification
    if (action.userId) {
      await sendUserNotification(
        action.userId,
        action.exportId,
        action.projectId,
        'processing'
      ).catch(err => log('Failed to send processing notification:', err));
    }
  }

  const { renderId, bucketName } = await renderMediaOnLambda({
    region: AWS_REGION as any,
    functionName: REMOTION_FUNCTION_NAME,
    serveUrl: REMOTION_SERVE_URL,
    composition: action.renderConfig.compositionId,
    inputProps: action.renderConfig.inputProps,
    codec: (action.renderConfig.codec as 'h264' | 'h265' | 'vp8' | 'vp9' | 'prores') || 'h264',
    imageFormat: 'jpeg',
    maxRetries: 1,
    privacy: 'public',
    outName: `export-${action.exportId}.mp4`,
    downloadBehavior: { type: 'play-in-browser' },
    framesPerLambda: 200,
    webhook: WEBHOOK_URL
      ? {
          url: WEBHOOK_URL,
          secret: WEBHOOK_SECRET || null,
          customData: {
            taskToken: action.taskToken,
            exportId: action.exportId,
            projectId: action.projectId,
            userId: action.userId,
          },
        }
      : undefined,
  });

  log(`Render started: renderId=${renderId}, bucket=${bucketName}`);

  // Update database with render details
  if (action.exportId) {
    await updateExportInDatabase(action.exportId, {
      renderId,
      bucketName,
      progress: 10,
    }).catch(err => log('Failed to update DB after render start:', err));
  }

  if (!WEBHOOK_URL) {
    log('WARNING: No webhook URL configured. Step Functions will timeout.');
  }

  return { renderId, bucketName };
}

// === Helpers ===
async function updateExportInDatabase(exportId: string, updates: any): Promise<void> {
  if (!API_BASE_URL) {
    console.log('[DB] API_BASE_URL not configured, skipping update');
    return;
  }

  try {
    console.log('[DB] Updating export:', { exportId, updates });

    const response = await axios.patch(`${API_BASE_URL}/api/export/internal/${exportId}`, updates, {
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_SECRET_KEY || '',
      },
      timeout: 10000,
    });

    console.log('[DB] Update successful:', response.data);
  } catch (error: any) {
    console.error('[DB] Update failed:', {
      exportId,
      error: error.message,
      response: error.response?.data,
    });
    throw error;
  }
}

async function sendUserNotification(
  userId: string,
  exportId: string,
  projectId: string,
  status: 'processing' | 'completed' | 'failed',
  outputUrl?: string,
  errorMessage?: string
): Promise<void> {
  if (!API_BASE_URL) {
    console.log('[Notify] API_BASE_URL not configured, skipping notification');
    return;
  }

  try {
    console.log('[Notify] Sending notification:', { userId, exportId, status });

    const response = await axios.post(
      `${API_BASE_URL}/api/export/internal/notification`,
      {
        userId,
        exportId,
        projectId,
        status,
        outputUrl,
        errorMessage,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': API_SECRET_KEY || '',
        },
        timeout: 10000,
      }
    );

    console.log('[Notify] Notification sent:', response.data);
  } catch (error: any) {
    console.error('[Notify] Notification failed:', {
      userId,
      exportId,
      error: error.message,
      response: error.response?.data,
    });
    throw error;
  }
}
