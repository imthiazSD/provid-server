# Remotion Lambda Integration Setup Guide

## Overview

This implementation integrates Remotion Lambda with your existing export system. Remotion Lambda handles video rendering in the cloud, and you can track progress via webhooks.

## Prerequisites

1. **AWS Account** with appropriate permissions
2. **Remotion License** (if using Remotion Lambda in production)
3. **Node.js** and **npm/yarn** installed

## Installation Steps

### 1. Install Remotion Lambda Dependencies

```bash
npm install @remotion/lambda @remotion/lambda/client
# or
yarn add @remotion/lambda @remotion/lambda/client
```

### 2. Deploy Remotion Lambda Function

Follow the Remotion Lambda setup:

```bash
# Install Remotion CLI globally
npm install -g @remotion/cli

# Deploy Lambda function
npx remotion lambda functions deploy

# Deploy your Remotion composition site
npx remotion lambda sites create src/remotion/index.ts --site-name=my-video-app
```

This will output:
- Lambda function name (e.g., `remotion-render-xyz`)
- Site URL (e.g., `https://s3.amazonaws.com/bucket/site.html`)

### 3. Configure Environment Variables

Copy `.env.example` to `.env` and update:

```bash
REMOTION_LAMBDA_FUNCTION_NAME=remotion-render-xyz
REMOTION_SERVE_URL=https://your-bucket.s3.amazonaws.com/site.html
API_BASE_URL=https://your-api.com
WEBHOOK_SECRET=generate_a_secure_random_string
```

### 4. Update Your Remotion Composition

Create a Remotion composition that accepts your project settings:

```typescript
// src/remotion/Composition.tsx
import { AbsoluteFill } from 'remotion';

export const MyComposition: React.FC<{
  videoUrl: string;
  compositionSettings: any;
}> = ({ videoUrl, compositionSettings }) => {
  return (
    <AbsoluteFill>
      {/* Your video composition logic */}
      <video src={videoUrl} />
      {/* Add overlays, effects, etc. based on compositionSettings */}
    </AbsoluteFill>
  );
};
```

## How It Works

### 1. Export Flow

```
User Request → Export Controller → Remotion Lambda → S3
     ↓                                    ↓
   Export                            Webhook ← Progress Updates
   Created                                ↓
                                    Update Export Status
```

### 2. Key Components

#### **RemotionLambdaService**
- Triggers renders on Lambda
- Fetches render progress
- Handles S3 bucket operations

#### **ExportController**
- Manages export requests
- Receives webhook updates from Remotion
- Updates export status in database

#### **Webhook Endpoint**
- Validates signature (optional but recommended)
- Updates export status based on render progress
- Sends notifications to users

### 3. Webhook Events

Remotion sends webhooks for:
- `success`: Render completed successfully
- `error`: Render failed
- `timeout`: Render exceeded time limit

## API Endpoints

### Start Export
```
POST /api/exports/projects/:projectId/export
Authorization: Bearer <token>

Body:
{
  "compositionId": "MainComposition",
  "codec": "h264"  // optional
}

Response:
{
  "success": true,
  "data": {
    "exportId": "...",
    "renderId": "...",
    "status": "processing"
  }
}
```

### Get Export Status
```
GET /api/exports/:exportId/status
Authorization: Bearer <token>

Response:
{
  "success": true,
  "data": {
    "exportId": "...",
    "status": "processing",
    "progress": {
      "overallProgress": 0.45,
      "done": false
    },
    "outputUrl": null
  }
}
```

### Get Export History
```
GET /api/exports/history?page=1&limit=10
Authorization: Bearer <token>

Response:
{
  "success": true,
  "data": {
    "exports": [...],
    "pagination": {
      "current": 1,
      "pages": 5,
      "total": 50
    }
  }
}
```

### Webhook (Internal - Called by Remotion)
```
POST /api/exports/webhook
X-Remotion-Signature: <signature>

Body:
{
  "type": "success",
  "renderId": "...",
  "outputFile": "https://s3.../export.mp4",
  "metadata": {
    "exportId": "...",
    "projectId": "...",
    "userId": "..."
  }
}
```

## Cost Optimization

### 1. Use Appropriate Codecs
- **h264**: Best compatibility, moderate size
- **h265**: Better compression, slower encoding
- **vp8/vp9**: WebM format, good for web

### 2. Configure Lambda Memory
Higher memory = faster rendering but higher cost. Adjust in Remotion Lambda settings.

### 3. Monitor Usage
Use CloudWatch to track:
- Number of renders
- Average render time
- Failed renders

## Security Considerations

### 1. Webhook Signature Validation
Always validate webhook signatures in production:

```typescript
WEBHOOK_SECRET=generate_secure_random_string_here
```

### 2. IAM Permissions
Grant minimum required permissions to Lambda:
- S3 read/write for specific bucket
- CloudWatch logs write
- Lambda execution

### 3. API Authentication
Ensure all endpoints except webhook require authentication.

## Troubleshooting

### Common Issues

**1. Render Fails Immediately**
- Check if serve URL is accessible
- Verify Lambda function has correct permissions
- Check CloudWatch logs for errors

**2. Webhook Not Received**
- Verify API_BASE_URL is publicly accessible
- Check webhook signature validation
- Review server logs for errors

**3. Slow Rendering**
- Increase Lambda memory allocation
- Optimize composition complexity
- Use appropriate codec settings

## Monitoring & Logging

### CloudWatch Metrics
- Lambda invocations
- Render duration
- Error rates

### Application Logs
```typescript
logger.info(`Export started: ${exportId}`);
logger.error(`Export failed: ${exportId}`, error);
```

## Next Steps

1. Deploy the updated code
2. Configure Remotion Lambda
3. Test with a sample export
4. Monitor webhooks and logs
5. Optimize based on performance metrics

## Resources

- [Remotion Lambda Docs](https://www.remotion.dev/docs/lambda)
- [Remotion SQS Integration](https://www.remotion.dev/docs/lambda/sqs)
- [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/)
- [Remotion Pricing](https://www.remotion.dev/pricing)

## Support

For issues specific to:
- **Remotion**: Check [Remotion Discord](https://remotion.dev/discord)
- **AWS**: Consult AWS Support
- **Integration**: Review logs and documentation above