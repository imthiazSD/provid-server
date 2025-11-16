import { renderMediaOnLambda, getRenderProgress } from '@remotion/lambda-client';
import { SFNClient, SendTaskSuccessCommand, SendTaskFailureCommand } from '@aws-sdk/client-sfn';
import axios from 'axios';

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

// === Main Handler ===
export const handler = async (event: any): Promise<any> => {
  const log = (msg: any) => console.log(`[WORKER] ${new Date().toISOString()} |`, msg);

  log('Lambda invoked');
  log('Event received:');
  log(JSON.stringify(event, null, 2));

  const action = event as RenderAction;

  try {
    switch (action.action) {
      case 'start':
        log('Action: start render');
        return await startRender(action, log);
      case 'webhook-complete':
        log('Action: webhook-complete');
        return await handleWebhookFinish(action, true, log);
      case 'webhook-failed':
        log('Action: webhook-failed');
        return await handleWebhookFinish(action, false, log);
      default:
        log(`Unknown action: ${action.action}`);
        throw new Error(`Unknown action: ${action.action}`);
    }
  } catch (error: any) {
    log('ERROR:');
    log(error);
    throw error;
  }
};

// === Start Render ===
async function startRender(action: RenderAction, log: (msg: any) => void): Promise<any> {
  log('Starting renderMediaOnLambda...');
  log({
    functionName: REMOTION_FUNCTION_NAME,
    serveUrl: REMOTION_SERVE_URL,
    composition: action.renderConfig.compositionId,
    exportId: action.exportId,
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
    webhook: {
      url: WEBHOOK_URL!,
      secret: WEBHOOK_SECRET,
      customData: { taskToken: action.taskToken }
    },
  });

  log(`Render started: renderId=${renderId}, bucket=${bucketName}`);

  await updateExportInDatabase(action.exportId, {
    status: 'processing',
    renderId,
    bucketName,
  });

  if (WEBHOOK_URL) {
    await sendWebhook({ type: 'render_started', exportId: action.exportId, renderId, bucketName });
    log('Webhook sent: render_started');
  }

  return { renderId, bucketName };
}
// === Webhook Finish ===
async function handleWebhookFinish(action: RenderAction, isSuccess: boolean, log: (msg: any) => void): Promise<any> {
  log(`Webhook finish: ${isSuccess ? 'success' : 'failed'}`);
  log({ exportId: action.exportId, outputUrl: action.outputUrl });

  const updates: any = { status: isSuccess ? 'completed' : 'failed' };
  if (isSuccess) updates.outputUrl = action.outputUrl;
  else updates.errorMessage = action.error?.message || 'Render failed';

  await updateExportInDatabase(action.exportId, updates);
  log('DB updated');

  if (WEBHOOK_URL) {
    await sendWebhook({
      type: isSuccess ? 'render_success' : 'render_error',
      exportId: action.exportId,
      outputFile: action.outputUrl,
      errors: isSuccess ? undefined : [{ message: updates.errorMessage }],
    });
    log('Webhook sent: render_success/error');
  }

  if (action.userId) {
    await sendUserNotification(action.userId, action.exportId, isSuccess ? 'completed' : 'failed');
    log('User notified');
  }

  const cmd = isSuccess
    ? new SendTaskSuccessCommand({ taskToken: action.taskToken!, output: JSON.stringify({ success: true }) })
    : new SendTaskFailureCommand({ taskToken: action.taskToken!, error: 'RenderFailed', cause: updates.errorMessage });

  log(`Sending ${isSuccess ? 'SendTaskSuccess' : 'SendTaskFailure'} to Step Functions`);
  await sfnClient.send(cmd);
  log('Step Functions resumed');

  return { success: true };
}

// === Helpers ===
async function updateExportInDatabase(exportId: string, updates: any): Promise<void> {
  console.log('[DB] Update:', { exportId, updates });
  // Replace with your DB logic (MongoDB, DynamoDB, etc.)
}

async function sendWebhook(payload: any): Promise<void> {
  if (!WEBHOOK_URL) return;
  const headers: any = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) {
    const crypto = await import('crypto');
    headers['X-Remotion-Signature'] = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(JSON.stringify(payload))
      .digest('hex');
  }
  await axios.post(WEBHOOK_URL, payload, { headers, timeout: 10000 }).catch(() => {});
}

async function sendUserNotification(userId: string, exportId: string, status: string): Promise<void> {
  console.log('[Notify] User:', { userId, exportId, status });
  // Replace with SNS, SES, etc.
}