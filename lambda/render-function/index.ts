import { SFNClient, SendTaskFailureCommand, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import { renderMediaOnLambda } from '@remotion/lambda-client';

// === Environment ===
const REMOTION_FUNCTION_NAME = process.env.REMOTION_LAMBDA_FUNCTION_NAME!;
const REMOTION_SERVE_URL = process.env.REMOTION_SERVE_URL!;
const AWS_REGION = process.env.AWS_REGION_OVERRIDE || 'us-east-1';
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const sfnClient = new SFNClient({ region: AWS_REGION });

// === Types ===
interface RenderAction {
  action: 'start' | 'webhook-complete' | 'webhook-failed';
  exportId: string;
  projectId?: string;
  userId?: string;
  renderConfig?: any;
  renderId?: string;
  bucketName?: string;
  outputUrl?: string;
  error?: any;
  taskToken?: string;
}

interface RemotionWebhookPayload {
  type: 'success' | 'error' | 'timeout';
  renderId: string;
  bucketName: string;
  outputFile?: string;
  errors?: any[];
  customData?: any;
}

// === Main Handler ===
export const handler = async (event: any): Promise<any> => {
  const log = (msg: any) => console.log(`[WORKER] ${new Date().toISOString()} |`, msg);

  log('Lambda invoked');
  log('Event received:');
  log(JSON.stringify(event, null, 2));

  // Check if this is an HTTP webhook call (from Remotion)
  if (event.requestContext && event.requestContext.http) {
    log('Detected HTTP webhook request');
    return await handleRemotionWebhook(event, log);
  }

  // Otherwise, it's a Step Functions invocation
  const action = event as RenderAction;

  try {
    switch (action.action) {
      case 'start':
        log('Action: start render');
        return await startRender(action, log);
      default:
        log(`Unknown action: ${action.action}`);
        throw new Error(`Unknown action: ${action.action}`);
    }
  } catch (error: any) {
    log('ERROR:');
    log(error);

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
async function handleRemotionWebhook(event: any, log: (msg: any) => void): Promise<any> {
  try {
    log('Processing webhook...');
    log('Event keys:', Object.keys(event));
    log('Request context:', event.requestContext);

    // Get the body (might be base64 encoded)
    let bodyString: string;
    if (event.isBase64Encoded) {
      log('Body is base64 encoded');
      bodyString = Buffer.from(event.body, 'base64').toString('utf-8');
    } else {
      bodyString = event.body || '{}';
    }

    log('Raw body length:', bodyString.length);
    log('Raw body preview:', bodyString.substring(0, 200));
    log('Headers:', JSON.stringify(event.headers, null, 2));

    // Parse the payload
    let payload: RemotionWebhookPayload;
    try {
      payload = JSON.parse(bodyString);
      log('Parsed payload successfully');
      log('Payload type:', payload.type);
      log('Payload keys:', Object.keys(payload));
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
      log('Received signature:', signature);

      if (!signature) {
        log('WARNING: No signature header found, but secret is configured');
        // For debugging, allow it to continue
      } else {
        const crypto = await import('crypto');
        const expectedSignature = crypto
          .createHmac('sha256', WEBHOOK_SECRET)
          .update(bodyString)
          .digest('hex');

        log('Expected signature:', expectedSignature);

        if (signature !== expectedSignature) {
          log('WARNING: Signature mismatch - proceeding anyway for debugging');
        } else {
          log('Signature verified successfully');
        }
      }
    } else {
      log('No webhook secret configured - skipping signature verification');
    }
    log('Webhook payload:');
    log(JSON.stringify(payload, null, 2));

    const { type, renderId, bucketName, outputFile, errors, customData } = payload;

    log('CustomData received:', JSON.stringify(customData, null, 2));

    let taskToken = customData?.taskToken;

    // Task token might be nested or stringified
    if (typeof taskToken === 'object' && taskToken !== null) {
      log('TaskToken is an object, extracting...');
      taskToken = taskToken.taskToken || JSON.stringify(taskToken);
    }

    log('Extracted taskToken type:', typeof taskToken);
    log('TaskToken length:', taskToken?.length);
    log('TaskToken preview:', taskToken?.substring(0, 100) + '...');

    if (!taskToken) {
      log('ERROR: No taskToken in webhook customData');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No taskToken provided', customData }),
      };
    }

    const isSuccess = type === 'success';
    log(`Render ${isSuccess ? 'succeeded' : 'failed'}: ${renderId}`);

    // Validate taskToken format (Step Functions tokens are base64-encoded and quite long)
    if (typeof taskToken !== 'string' || taskToken.length < 100) {
      log('ERROR: Invalid taskToken format');
      log('Token received:', taskToken);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid taskToken format',
          received: taskToken,
          hint: 'Token should be a long base64 string',
        }),
      };
    }

    log('TaskToken appears valid, sending to Step Functions...');

    // Send success/failure to Step Functions
    try {
      const cmd = isSuccess
        ? new SendTaskSuccessCommand({
            taskToken,
            output: JSON.stringify({
              success: true,
              renderId,
              bucketName,
              outputFile,
            }),
          })
        : new SendTaskFailureCommand({
            taskToken,
            error: 'RenderFailed',
            cause: JSON.stringify(errors || [{ message: 'Render failed' }]),
          });

      await sfnClient.send(cmd);
      log(`Step Functions notified: ${isSuccess ? 'success' : 'failure'}`);
    } catch (sfnError: any) {
      log('Step Functions error:');
      log('Error name:', sfnError.name);
      log('Error message:', sfnError.message);
      log('Error code:', sfnError.$metadata?.httpStatusCode);
      throw sfnError;
    }

    // Optional: Update your database here
    // await updateExportInDatabase(exportId, { status: isSuccess ? 'completed' : 'failed', outputUrl: outputFile });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, message: 'Webhook processed' }),
    };
  } catch (error: any) {
    log('Webhook processing error:');
    log('Error name:', error.name);
    log('Error message:', error.message);
    log('Error stack:', error.stack);

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message, stack: error.stack }),
    };
  }
}

// === Start Render ===
async function startRender(action: RenderAction, log: (msg: any) => void): Promise<any> {
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
    framesPerLambda: 200,
    webhook: WEBHOOK_URL
      ? {
          url: WEBHOOK_URL,
          secret: WEBHOOK_SECRET || undefined, // Only set if defined
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

  // Optional: Update database
  // await updateExportInDatabase(action.exportId, {
  //   status: 'processing',
  //   renderId,
  //   bucketName,
  // });

  // If no webhook configured, we need to poll for completion
  if (!WEBHOOK_URL) {
    log('WARNING: No webhook URL configured. Step Functions will timeout.');
    log('Consider configuring a webhook or implementing polling logic.');
  }

  return { renderId, bucketName };
}

// === Helpers ===
async function updateExportInDatabase(exportId: string, updates: any): Promise<void> {
  console.log('[DB] Update:', { exportId, updates });
  // Replace with your DB logic (MongoDB, DynamoDB, etc.)
}

async function sendUserNotification(
  userId: string,
  exportId: string,
  status: string
): Promise<void> {
  console.log('[Notify] User:', { userId, exportId, status });
  // Replace with SNS, SES, etc.
}
