# Quick Reference - Remotion Lambda + SQS

## 🚀 One-Command Setup

```bash
./infrastructure/setup-sqs-lambda.sh
```

## 📋 Essential Commands

### Deployment

```bash
# Deploy entire infrastructure
./infrastructure/setup-sqs-lambda.sh

# Deploy only Remotion Lambda
npx remotion lambda functions deploy --region us-east-1

# Deploy only Remotion site
npx remotion lambda sites create src/remotion/index.tsx --region us-east-1

# Update Lambda worker code
cd lambda/render-function
npm run build && npm run package
aws lambda update-function-code \
  --function-name remotion-render-worker \
  --zip-file fileb://function.zip
```

### Testing

```bash
# Test complete export flow
AUTH_TOKEN="your_token" ./test-export.sh PROJECT_ID

# Test webhook endpoint
curl -X POST http://localhost:3000/api/exports/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"render_started","exportId":"test123"}'

# Start export manually
curl -X POST http://localhost:3000/api/exports/projects/PROJECT_ID/export \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"compositionId":"MainComposition","codec":"h264"}'

# Check export status
curl http://localhost:3000/api/exports/EXPORT_ID/status \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

### Monitoring

```bash
# Watch Lambda worker logs
aws logs tail /aws/lambda/remotion-render-worker --follow --region us-east-1

# Watch Remotion Lambda logs
aws logs tail /aws/lambda/remotion-render-3-0-135-mem2048mb-disk2048mb-240sec --follow

# Check SQS queue stats
aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names All \
  --region us-east-1

# Count messages in queue
aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages'

# List all Remotion renders
npx remotion lambda renders ls --region us-east-1

# Get render progress
npx remotion lambda renders progress RENDER_ID --region us-east-1
```

### Database Queries

```javascript
// Count exports by status
db.exportrequests.aggregate([
  { $group: { _id: "$status", count: { $sum: 1 } } }
])

// Recent exports
db.exportrequests.find().sort({ createdAt: -1 }).limit(10)

// Failed exports
db.exportrequests.find({ status: "failed" }).sort({ createdAt: -1 })

// Average export time
db.exportrequests.aggregate([
  { $match: { status: "completed" } },
  {
    $project: {
      duration: { $subtract: ["$updatedAt", "$createdAt"] }
    }
  },
  {
    $group: {
      _id: null,
      avgMs: { $avg: "$duration" },
      minMs: { $min: "$duration" },
      maxMs: { $max: "$duration" }
    }
  }
])

// Exports in last 24 hours
db.exportrequests.find({
  createdAt: { $gte: new Date(Date.now() - 24*60*60*1000) }
}).count()
```

### Cleanup

```bash
# Delete SQS queue
aws sqs delete-queue --queue-url $QUEUE_URL

# Delete Lambda worker
aws lambda delete-function --function-name remotion-render-worker

# Delete IAM role
aws iam delete-role --role-name remotion-render-lambda-role

# Delete Remotion function
npx remotion lambda functions rm FUNCTION_NAME --region us-east-1

# Delete Remotion site
npx remotion lambda sites rm SITE_ID --region us-east-1

# Delete all old renders
npx remotion lambda renders rmall --region us-east-1
```

## 🔧 Configuration

### Environment Variables

```bash
# Required
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
REMOTION_SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/.../remotion-render-queue
REMOTION_LAMBDA_FUNCTION_NAME=remotion-render-3-0-135...
REMOTION_SERVE_URL=https://remotionlambda-useast1-...
API_BASE_URL=https://your-api.com
WEBHOOK_SECRET=$(openssl rand -hex 32)

# Optional
MONGODB_URI=mongodb://localhost:27017/db
NODE_ENV=production
PORT=3000
```

### Lambda Configuration

```bash
# Update Lambda memory
aws lambda update-function-configuration \
  --function-name remotion-render-worker \
  --memory-size 3008

# Update Lambda timeout
aws lambda update-function-configuration \
  --function-name remotion-render-worker \
  --timeout 900

# Update environment variables
aws lambda update-function-configuration \
  --function-name remotion-render-worker \
  --environment "Variables={
    REMOTION_LAMBDA_FUNCTION_NAME=...,
    REMOTION_SERVE_URL=...,
    WEBHOOK_SECRET=...
  }"
```

### SQS Configuration

```bash
# Update visibility timeout
aws sqs set-queue-attributes \
  --queue-url $QUEUE_URL \
  --attributes VisibilityTimeout=900

# Update message retention
aws sqs set-queue-attributes \
  --queue-url $QUEUE_URL \
  --attributes MessageRetentionPeriod=86400

# Purge queue (delete all messages)
aws sqs purge-queue --queue-url $QUEUE_URL
```

## 📊 Health Checks

### Quick Status Check

```bash
#!/bin/bash

echo "=== System Health Check ==="

# Check SQS queue
MESSAGES=$(aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' \
  --output text)
echo "Messages in queue: $MESSAGES"

# Check Lambda function
LAMBDA_STATUS=$(aws lambda get-function \
  --function-name remotion-render-worker \
  --query 'Configuration.State' \
  --output text)
echo "Lambda status: $LAMBDA_STATUS"

# Check recent exports
PENDING=$(mongo $MONGODB_URI --quiet --eval \
  'db.exportrequests.count({status:"pending"})')
PROCESSING=$(mongo $MONGODB_URI --quiet --eval \
  'db.exportrequests.count({status:"processing"})')
FAILED=$(mongo $MONGODB_URI --quiet --eval \
  'db.exportrequests.count({status:"failed",createdAt:{$gte:new Date(Date.now()-86400000)}})')

echo "Pending exports: $PENDING"
echo "Processing exports: $PROCESSING"
echo "Failed (24h): $FAILED"
```

## 🐛 Debug Commands

### Check Lambda Execution

```bash
# Get last 10 invocations
aws lambda get-function \
  --function-name remotion-render-worker \
  --query 'Configuration.[LastModified,FunctionArn,State,StateReason]'

# Invoke Lambda manually with test event
aws lambda invoke \
  --function-name remotion-render-worker \
  --payload file://test-event.json \
  response.json

# Check concurrent executions
aws lambda get-function-concurrency \
  --function-name remotion-render-worker
```

### Check SQS Message

```bash
# Peek at message without deleting
aws sqs receive-message \
  --queue-url $QUEUE_URL \
  --max-number-of-messages 1 \
  --visibility-timeout 0

# Receive and delete message
aws sqs receive-message \
  --queue-url $QUEUE_URL \
  --max-number-of-messages 1 \
  --attribute-names All

# Send test message
aws sqs send-message \
  --queue-url $QUEUE_URL \
  --message-body '{
    "type":"RENDER_VIDEO",
    "exportId":"test123",
    "projectId":"proj456",
    "userId":"user789",
    "renderConfig":{
      "compositionId":"MainComposition",
      "inputProps":{},
      "codec":"h264"
    }
  }'
```

### Check Remotion Render

```bash
# Get render details
npx remotion lambda renders info RENDER_ID --region us-east-1

# Get render progress
npx remotion lambda renders progress RENDER_ID --region us-east-1

# Cancel render
npx remotion lambda renders cancel RENDER_ID --region us-east-1

# List failed renders
npx remotion lambda renders ls --region us-east-1 | grep "failed"
```

## 📈 Performance Tuning

### Optimize Lambda

```bash
# Increase memory (faster but more expensive)
aws lambda update-function-configuration \
  --function-name remotion-render-worker \
  --memory-size 3008  # or 1024, 2048, 4096

# Set reserved concurrency (limit parallel executions)
aws lambda put-function-concurrency \
  --function-name remotion-render-worker \
  --reserved-concurrent-executions 10

# Remove reserved concurrency
aws lambda delete-function-concurrency \
  --function-name remotion-render-worker
```

### Optimize Remotion Lambda

```bash
# Deploy with more memory
npx remotion lambda functions deploy \
  --memory 3009 \
  --disk 2048 \
  --timeout 240

# Deploy with custom settings
npx remotion lambda functions deploy \
  --region us-east-1 \
  --memory 2048 \
  --disk 2048 \
  --timeout 120 \
  --enable-v5
```

## 🔐 Security Commands

### Generate Webhook Secret

```bash
# Generate strong secret
openssl rand -hex 32

# Add to .env
echo "WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env

# Update Lambda environment
aws lambda update-function-configuration \
  --function-name remotion-render-worker \
  --environment "Variables={WEBHOOK_SECRET=$(openssl rand -hex 32)}"
```

### Rotate AWS Keys

```bash
# Create new access key
aws iam create-access-key --user-name your-user

# Update .env with new keys
# Delete old access key
aws iam delete-access-key \
  --access-key-id OLD_KEY_ID \
  --user-name your-user
```

## 💰 Cost Commands

### Check Costs

```bash
# Lambda invocations (last 7 days)
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=remotion-render-worker \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum

# SQS requests (last 7 days)
aws cloudwatch get-metric-statistics \
  --namespace AWS/SQS \
  --metric-name NumberOfMessagesSent \
  --dimensions Name=QueueName,Value=remotion-render-queue \
  --start-time $(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 86400 \
  --statistics Sum

# S3 storage size
aws s3 ls s3://remotionlambda-useast1-xxx --recursive \
  --summarize --human-readable
```

## 📞 Support

### Get Help

```bash
# Remotion Discord
# https://remotion.dev/discord

# Check Remotion version
npx remotion --version

# Check AWS CLI version
aws --version

# Check Node version
node --version
```

## ⚡ Pro Tips

```bash
# Alias for common commands
alias render-logs='aws logs tail /aws/lambda/remotion-render-worker --follow'
alias queue-stats='aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names All'
alias export-test='AUTH_TOKEN=$AUTH_TOKEN ./test-export.sh'

# Watch queue depth in real-time
watch -n 5 'aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names ApproximateNumberOfMessages --query "Attributes.ApproximateNumberOfMessages"'

# Monitor Lambda errors
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Errors \
  --dimensions Name=FunctionName,Value=remotion-render-worker \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum
```