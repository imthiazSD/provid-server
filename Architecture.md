# Remotion Lambda + SQS Architecture

## Overview

This system implements video rendering using Remotion Lambda with an SQS-based queue architecture, following the [official Remotion SQS pattern](https://www.remotion.dev/docs/lambda/sqs).

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENT LAYER                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ POST /api/exports/projects/:id/export
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           EXPRESS API SERVER                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  ExportController                                                 │   │
│  │  • Creates export record in MongoDB                              │   │
│  │  • Validates project ownership                                   │   │
│  │  • Enqueues render request to SQS                               │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                           │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  RemotionSQSService                                              │   │
│  │  • Sends messages to SQS queue                                   │   │
│  │  • Queries render progress (optional polling)                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ SendMessage
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          AMAZON SQS QUEUE                                │
│  • Queue Name: remotion-render-queue                                     │
│  • Visibility Timeout: 15 minutes                                        │
│  • Message Retention: 24 hours                                           │
│  • Dead Letter Queue: (optional)                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Event Source Mapping
                                    │ (Batch Size: 1)
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      LAMBDA RENDER WORKER                                │
│  Function: remotion-render-worker                                        │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  1. Receive SQS message                                          │   │
│  │  2. Parse render configuration                                   │   │
│  │  3. Call renderMediaOnLambda()                                   │   │
│  │  4. Poll for render completion                                   │   │
│  │  5. Send webhook to API on completion/error                      │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ renderMediaOnLambda()
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                       REMOTION LAMBDA FUNCTION                           │
│  Function: remotion-render-3-0-135-mem2048mb-disk2048mb-240sec          │
│  • Renders video using Remotion composition                              │
│  • Processes frames in parallel                                          │
│  • Uploads output to S3                                                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Upload
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           AMAZON S3 BUCKET                               │
│  • Stores rendered video files                                           │
│  • Public read access (configurable)                                     │
│  • Lifecycle policies for cleanup                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Webhook Callback
                                    │ POST /api/exports/webhook
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           EXPRESS API SERVER                             │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │  Webhook Handler                                                 │   │
│  │  • Validates webhook signature                                   │   │
│  │  • Updates export status in MongoDB                              │   │
│  │  • Sends notification to user                                    │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ Notification
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              USER NOTIFICATION                           │
│  • Email, SMS, WebSocket, or Push Notification                           │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Breakdown

### 1. Express API Server

**Responsibilities:**
- Handle user requests for video exports
- Validate user permissions and project ownership
- Create export records in MongoDB
- Enqueue render requests to SQS
- Receive webhook callbacks from Lambda
- Update export status and notify users

**Key Endpoints:**
- `POST /api/exports/projects/:projectId/export` - Start new export
- `GET /api/exports/:exportId/status` - Check export status
- `GET /api/exports/history` - Get export history
- `POST /api/exports/webhook` - Receive render completion callbacks

### 2. Amazon SQS Queue

**Purpose:** Decouples API from rendering workload

**Configuration:**
- **Visibility Timeout:** 900 seconds (15 minutes)
  - Prevents other consumers from processing the same message
  - Should be >= Lambda timeout
- **Message Retention:** 86400 seconds (24 hours)
  - How long messages stay in queue if not processed
- **Receive Message Wait Time:** 20 seconds
  - Long polling to reduce costs

**Benefits:**
- Handles traffic spikes gracefully
- Automatic retries on Lambda failures
- Dead letter queue for failed messages (optional)
- Cost-effective compared to maintaining worker servers

### 3. Lambda Render Worker

**Purpose:** Consumes SQS messages and triggers Remotion renders

**Function Details:**
- **Runtime:** Node.js 18.x
- **Memory:** 2048 MB
- **Timeout:** 900 seconds (15 minutes)
- **Trigger:** SQS Event Source Mapping

**Process Flow:**
1. Receives message from SQS (batch size: 1)
2. Parses render configuration from message
3. Sends "render_started" webhook to API
4. Calls `renderMediaOnLambda()` with configuration
5. Polls for render completion every 5 seconds
6. Sends "render_success" or "render_error" webhook
7. Returns success/failure to SQS

**Error Handling:**
- Fatal errors: Returns failure, message goes to DLQ
- Transient errors: Message becomes visible again after timeout
- Webhook failures: Logged but don't fail the render

### 4. Remotion Lambda Function

**Purpose:** Actually renders the video

**Characteristics:**
- Deployed by Remotion CLI
- Scales automatically based on demand
- Processes video frames in parallel
- Uploads directly to S3

**Configuration:**
- Created via `npx remotion lambda functions deploy`
- Memory and timeout configured during deployment
- Needs IAM permissions for S3, CloudWatch

### 5. Amazon S3 Bucket

**Purpose:** Stores rendered video files

**Configuration:**
- Public read access (or signed URLs)
- CORS configured for web access
- Lifecycle policies to delete old files
- Server-side encryption (optional)

**Structure:**
```
bucket-name/
  renders/
    export-{exportId}.mp4
  sites/
    {siteId}/
      index.html
      bundle.js
```

### 6. MongoDB Database

**Collections:**

**ExportRequest:**
```javascript
{
  _id: ObjectId,
  projectId: ObjectId,
  userId: ObjectId,
  status: 'pending' | 'processing' | 'completed' | 'failed',
  queueMessageId: String,    // SQS message ID
  renderId: String,           // Remotion render ID
  bucketName: String,         // S3 bucket name
  outputUrl: String,          // Final video URL
  errorMessage: String,
  createdAt: Date,
  updatedAt: Date
}
```

## Data Flow

### 1. Export Request Flow

```
User → API
  ↓
Create Export Record (status: 'pending')
  ↓
Send Message to SQS
  {
    type: 'RENDER_VIDEO',
    exportId: '...',
    projectId: '...',
    userId: '...',
    renderConfig: {
      compositionId: 'MainComposition',
      inputProps: {...},
      codec: 'h264',
      webhookUrl: 'https://api.example.com/exports/webhook'
    }
  }
  ↓
Return to User
  {
    exportId: '...',
    status: 'pending',
    queueMessageId: '...'
  }
```

### 2. Render Processing Flow

```
SQS → Lambda Worker
  ↓
Parse Message
  ↓
Webhook: render_started
  ↓
API Updates Status to 'processing'
  ↓
Call renderMediaOnLambda()
  {
    region: 'us-east-1',
    functionName: 'remotion-render-...',
    serveUrl: 'https://...s3.../index.html',
    composition: 'MainComposition',
    inputProps: {...},
    codec: 'h264',
    outName: 'export-{exportId}.mp4'
  }
  ↓
Remotion Lambda Renders Video
  ↓
Upload to S3
  ↓
Lambda Worker Polls for Completion
  ↓
Webhook: render_success
  {
    type: 'render_success',
    exportId: '...',
    outputFile: 'https://...s3.../export-....mp4',
    renderId: '...',
    bucketName: '...'
  }
  ↓
API Updates Status to 'completed'
  ↓
Send User Notification
```

### 3. Error Handling Flow

```
Error in Lambda Worker
  ↓
Webhook: render_error
  {
    type: 'render_error',
    exportId: '...',
    errors: [{message: '...', stack: '...'}]
  }
  ↓
API Updates Status to 'failed'
  ↓
Send User Notification
  ↓
Lambda Returns Failure to SQS
  ↓
Message Retried or Sent to DLQ
```

## Security

### IAM Roles & Permissions

**Lambda Worker Role:**
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility"
      ],
      "Resource": "arn:aws:sqs:*:*:remotion-render-queue"
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction",
        "lambda:GetFunction"
      ],
      "Resource": "arn:aws:lambda:*:*:function:remotion-render-*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::remotionlambda-*",
        "arn:aws:s3:::remotionlambda-*/*"
      ]
    }
  ]
}
```

### Webhook Security

- HMAC-SHA256 signature verification
- Signature sent in `X-Remotion-Signature` header
- Timing-safe comparison to prevent timing attacks
- Secret stored in environment variables

### API Security

- JWT-based authentication
- Project ownership verification
- Rate limiting on export endpoints
- Input validation and sanitization

## Monitoring & Observability

### CloudWatch Metrics

**Lambda Worker:**
- Invocations
- Errors
- Duration
- Throttles
- Concurrent executions

**SQS Queue:**
- Messages sent
- Messages received
- Messages deleted
- Approximate age of oldest message
- Approximate number of messages visible

**Remotion Lambda:**
- Invocations
- Errors
- Duration
- Memory usage

### CloudWatch Logs

**Lambda Worker Logs:**
```
/aws/lambda/remotion-render-worker
```

**Remotion Lambda Logs:**
```
/aws/lambda/remotion-render-3-0-135-mem2048mb-disk2048mb-240sec
```

### Application Logs

```javascript
logger.info('Export request queued', { exportId, messageId });
logger.info('Render started', { exportId, renderId });
logger.info('Render completed', { exportId, outputUrl });
logger.error('Render failed', { exportId, error });
```

## Cost Analysis

### Per Export Breakdown

**SQS:**
- $0.40 per million requests
- ~3 requests per export (send, receive, delete)
- Cost: < $0.001 per export

**Lambda Worker:**
- $0.0000166667 per GB-second
- 2GB memory × 60 seconds average
- Cost: ~$0.002 per export

**Remotion Lambda:**
- $0.0000166667 per GB-second
- 3GB memory × 120 seconds average (2 min render)
- Cost: ~$0.006 per export

**S3 Storage:**
- $0.023 per GB per month
- 50MB average video size
- Cost: ~$0.001 per month per video

**Data Transfer:**
- First 100GB free per month
- Then $0.09 per GB
- Negligible for moderate usage

**Total per Export:** ~$0.009 (less than 1 cent!)

### Monthly Cost (1000 exports)

- SQS: $0.001 × 1000 = $1
- Lambda Worker: $0.002 × 1000 = $2
- Remotion Lambda: $0.006 × 1000 = $6
- S3 Storage (50GB): $1.15
- Data Transfer (assume within free tier): $0

**Total: ~$10/month for 1000 exports**

## Scaling Considerations

### Horizontal Scaling

- **SQS:** No limit, handles millions of messages
- **Lambda:** Default 1000 concurrent executions (can request increase)
- **Remotion Lambda:** Scales automatically, subject to Lambda limits

### Vertical Scaling

- Increase Lambda memory for faster processing
- Higher memory = more CPU = faster renders
- Trade-off: Higher cost per execution

### Concurrency Limits

- Lambda account limit: 1000 concurrent executions
- Can be increased via AWS Support
- Reserved concurrency can be set per function
- Monitor throttling in CloudWatch

## Troubleshooting

### Common Issues

**1. Messages stuck in queue**
- Check Lambda errors in CloudWatch
- Verify Lambda has correct IAM permissions
- Check visibility timeout settings

**2. Renders timeout**
- Increase Lambda timeout
- Optimize Remotion composition
- Check Remotion Lambda memory settings

**3. Webhook not received**
- Verify API_BASE_URL is publicly accessible
- Check webhook signature validation
- Review API server logs

**4. High costs**
- Monitor CloudWatch metrics
- Optimize Lambda memory settings
- Implement S3 lifecycle policies
- Consider reserved concurrency

## Best Practices

1. **Use Dead Letter Queue** for failed messages
2. **Set up CloudWatch Alarms** for errors and throttles
3. **Implement exponential backoff** for webhook retries
4. **Use S3 lifecycle policies** to delete old renders
5. **Monitor queue depth** to detect issues early
6. **Test webhook failures** in staging environment
7. **Set reasonable timeouts** to avoid hanging renders
8. **Use structured logging** for better debugging
9. **Implement rate limiting** on export API
10. **Regular cost reviews** to optimize spending