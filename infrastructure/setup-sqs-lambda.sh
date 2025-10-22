#!/bin/bash

# Setup SQS Queue and Lambda Function for Remotion Rendering
# This script creates the infrastructure needed for the SQS + Lambda pattern

set -e

REGION="${AWS_REGION:-us-east-1}"
QUEUE_NAME="remotion-render-queue"
LAMBDA_FUNCTION_NAME="remotion-render-worker"
LAMBDA_ROLE_NAME="remotion-render-lambda-role"

echo "🚀 Setting up Remotion SQS + Lambda Infrastructure"
echo "Region: $REGION"
echo ""

# Step 1: Create SQS Queue
echo "1️⃣  Creating SQS Queue: $QUEUE_NAME..."

QUEUE_URL=$(aws sqs create-queue \
  --queue-name $QUEUE_NAME \
  --region $REGION \
  --attributes '{
    "MessageRetentionPeriod": "86400",
    "VisibilityTimeout": "900",
    "ReceiveMessageWaitTimeSeconds": "20"
  }' \
  --query 'QueueUrl' \
  --output text 2>/dev/null || aws sqs get-queue-url --queue-name $QUEUE_NAME --region $REGION --query 'QueueUrl' --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url $QUEUE_URL \
  --attribute-names QueueArn \
  --region $REGION \
  --query 'Attributes.QueueArn' \
  --output text)

echo "✅ Queue created"
echo "   URL: $QUEUE_URL"
echo "   ARN: $QUEUE_ARN"
echo ""

# Step 2: Create IAM Role for Lambda
echo "2️⃣  Creating IAM Role: $LAMBDA_ROLE_NAME..."

# Create trust policy
cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
ROLE_ARN=$(aws iam create-role \
  --role-name $LAMBDA_ROLE_NAME \
  --assume-role-policy-document file:///tmp/trust-policy.json \
  --query 'Role.Arn' \
  --output text 2>/dev/null || aws iam get-role --role-name $LAMBDA_ROLE_NAME --query 'Role.Arn' --output text)

echo "✅ Role created: $ROLE_ARN"
echo ""

# Step 3: Attach Policies to Role
echo "3️⃣  Attaching policies to role..."

# Basic Lambda execution
aws iam attach-role-policy \
  --role-name $LAMBDA_ROLE_NAME \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
  2>/dev/null || true

# SQS permissions
cat > /tmp/sqs-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ChangeMessageVisibility"
      ],
      "Resource": "$QUEUE_ARN"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name $LAMBDA_ROLE_NAME \
  --policy-name sqs-policy \
  --policy-document file:///tmp/sqs-policy.json

# Remotion execution policy (should already exist from Remotion setup)
aws iam attach-role-policy \
  --role-name $LAMBDA_ROLE_NAME \
  --policy-arn arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/remotion-executionrole-policy \
  2>/dev/null || echo "⚠️  Warning: remotion-executionrole-policy not found. Please create it first."

echo "✅ Policies attached"
echo ""

# Wait for IAM role to propagate
echo "⏳ Waiting for IAM role to propagate (10 seconds)..."
sleep 10

# Step 4: Build Lambda Function
echo "4️⃣  Building Lambda function..."

cd lambda/render-function

# Install dependencies
npm install

# Build TypeScript
npm run build

# Create deployment package
echo "📦 Creating deployment package..."
cd dist
zip -r ../function.zip . > /dev/null
cd ..
zip -r function.zip node_modules > /dev/null

echo "✅ Lambda package created: function.zip"
echo ""

# Step 5: Deploy Remotion Lambda (if not already deployed)
echo "5️⃣  Checking Remotion Lambda deployment..."

REMOTION_FUNCTION_NAME=$(npx remotion lambda functions ls 2>/dev/null | grep -oP 'remotion-render-\S+' | head -1 || echo "")

if [ -z "$REMOTION_FUNCTION_NAME" ]; then
    echo "Deploying Remotion Lambda function..."
    npx remotion lambda functions deploy --region $REGION
    REMOTION_FUNCTION_NAME=$(npx remotion lambda functions ls | grep -oP 'remotion-render-\S+' | head -1)
fi

echo "✅ Remotion Lambda function: $REMOTION_FUNCTION_NAME"

# Deploy Remotion site if not exists
REMOTION_SERVE_URL=$(npx remotion lambda sites ls 2>/dev/null | grep -oP 'https://\S+' | head -1 || echo "")

if [ -z "$REMOTION_SERVE_URL" ]; then
    echo "Deploying Remotion site..."
    cd ../../src/remotion
    npx remotion lambda sites create --region $REGION
    REMOTION_SERVE_URL=$(npx remotion lambda sites ls | grep -oP 'https://\S+' | head -1)
    cd ../../lambda/render-function
fi

echo "✅ Remotion serve URL: $REMOTION_SERVE_URL"
echo ""

# Step 6: Create/Update Lambda Function
echo "6️⃣  Deploying Lambda worker function..."

# Check if function exists
FUNCTION_EXISTS=$(aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --region $REGION 2>/dev/null && echo "true" || echo "false")

if [ "$FUNCTION_EXISTS" = "false" ]; then
    echo "Creating new Lambda function..."
    
    aws lambda create-function \
      --function-name $LAMBDA_FUNCTION_NAME \
      --runtime nodejs18.x \
      --role $ROLE_ARN \
      --handler index.handler \
      --zip-file fileb://function.zip \
      --timeout 900 \
      --memory-size 2048 \
      --region $REGION \
      --environment "Variables={
        REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,
        REMOTION_SERVE_URL=$REMOTION_SERVE_URL,
        AWS_REGION=$REGION,
        WEBHOOK_SECRET=${WEBHOOK_SECRET:-}
      }" \
      > /dev/null
    
    echo "✅ Lambda function created"
else
    echo "Updating existing Lambda function..."
    
    aws lambda update-function-code \
      --function-name $LAMBDA_FUNCTION_NAME \
      --zip-file fileb://function.zip \
      --region $REGION \
      > /dev/null
    
    aws lambda update-function-configuration \
      --function-name $LAMBDA_FUNCTION_NAME \
      --timeout 900 \
      --memory-size 2048 \
      --environment "Variables={
        REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,
        REMOTION_SERVE_URL=$REMOTION_SERVE_URL,
        AWS_REGION=$REGION,
        WEBHOOK_SECRET=${WEBHOOK_SECRET:-}
      }" \
      --region $REGION \
      > /dev/null
    
    echo "✅ Lambda function updated"
fi

echo ""

# Step 7: Configure SQS Trigger
echo "7️⃣  Configuring SQS trigger for Lambda..."

# Get Lambda ARN
LAMBDA_ARN=$(aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --region $REGION --query 'Configuration.FunctionArn' --output text)

# Create event source mapping
MAPPING_UUID=$(aws lambda list-event-source-mappings \
  --function-name $LAMBDA_FUNCTION_NAME \
  --region $REGION \
  --query "EventSourceMappings[?EventSourceArn=='$QUEUE_ARN'].UUID" \
  --output text)

if [ -z "$MAPPING_UUID" ]; then
    aws lambda create-event-source-mapping \
      --function-name $LAMBDA_FUNCTION_NAME \
      --event-source-arn $QUEUE_ARN \
      --batch-size 1 \
      --maximum-batching-window-in-seconds 0 \
      --function-response-types ReportBatchItemFailures \
      --region $REGION \
      > /dev/null
    
    echo "✅ SQS trigger configured"
else
    echo "✅ SQS trigger already exists"
fi

echo ""

# Step 8: Update .env file
echo "8️⃣  Updating .env file..."

cd ../../

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
    else
        touch .env
    fi
fi

# Update or add environment variables
sed -i.bak "s|REMOTION_SQS_QUEUE_URL=.*|REMOTION_SQS_QUEUE_URL=$QUEUE_URL|" .env
sed -i.bak "s|REMOTION_LAMBDA_FUNCTION_NAME=.*|REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME|" .env
sed -i.bak "s|REMOTION_SERVE_URL=.*|REMOTION_SERVE_URL=$REMOTION_SERVE_URL|" .env

# Add if not exists
grep -q "REMOTION_SQS_QUEUE_URL" .env || echo "REMOTION_SQS_QUEUE_URL=$QUEUE_URL" >> .env
grep -q "REMOTION_LAMBDA_FUNCTION_NAME" .env || echo "REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME" >> .env
grep -q "REMOTION_SERVE_URL" .env || echo "REMOTION_SERVE_URL=$REMOTION_SERVE_URL" >> .env

rm -f .env.bak

echo "✅ .env file updated"
echo ""

# Summary
echo "════════════════════════════════════════════════════════════════"
echo "✅ Infrastructure Setup Complete!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📋 Configuration Summary:"
echo "   Region: $REGION"
echo "   SQS Queue: $QUEUE_NAME"
echo "   Queue URL: $QUEUE_URL"
echo "   Lambda Function: $LAMBDA_FUNCTION_NAME"
echo "   Remotion Function: $REMOTION_FUNCTION_NAME"
echo "   Remotion Site: $REMOTION_SERVE_URL"
echo ""
echo "🔧 Next Steps:"
echo "   1. Set WEBHOOK_SECRET in .env: openssl rand -hex 32"
echo "   2. Set API_BASE_URL in .env to your public API URL"
echo "   3. Restart your API server"
echo "   4. Test: ./test-export.sh <project_id>"
echo ""
echo "📊 Monitor:"
echo "   SQS Messages: aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names All"
echo "   Lambda Logs: aws logs tail /aws/lambda/$LAMBDA_FUNCTION_NAME --follow"
echo "   List Renders: npx remotion lambda renders ls"
echo ""
echo "🗑️  Cleanup:"
echo "   Delete Queue: aws sqs delete-queue --queue-url $QUEUE_URL"
echo "   Delete Lambda: aws lambda delete-function --function-name $LAMBDA_FUNCTION_NAME"
echo "   Delete Role: aws iam delete-role --role-name $LAMBDA_ROLE_NAME"
echo ""
echo "════════════════════════════════════════════════════════════════"