#!/bin/bash

# Setup SQS Queue and Lambda Function for Remotion Rendering
# This script creates the infrastructure needed for the SQS + Lambda pattern

set -e

# Default region if AWS_REGION is not set
REGION="${AWS_REGION:-us-east-1}"
QUEUE_NAME="remotion-render-queue"
LAMBDA_FUNCTION_NAME="remotion-render-worker"
LAMBDA_ROLE_NAME="remotion-render-lambda-role"
BUCKET_NAME="remotion-lambda-deployment-$(date +%s)"

echo "🚀 Setting up Remotion SQS + Lambda Infrastructure"
echo "Region: $REGION"
echo ""

# Validate AWS region
VALID_REGIONS=("eu-central-1" "eu-central-2" "eu-west-1" "eu-west-2" "eu-west-3" "eu-south-1" "eu-north-1" "us-east-1" "us-east-2" "us-west-1" "us-west-2" "af-south-1" "ap-south-1" "ap-east-1" "ap-southeast-1" "ap-southeast-2" "ap-northeast-1" "ap-northeast-2" "ap-northeast-3" "ap-southeast-4" "ap-southeast-5" "ca-central-1" "me-south-1" "sa-east-1")
if [[ ! " ${VALID_REGIONS[@]} " =~ " ${REGION} " ]]; then
    echo "❌ Invalid AWS region: $REGION"
    echo "Must be one of: ${VALID_REGIONS[*]}"
    exit 1
fi

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

# Step 2: Create IAM Role for Lambda Worker
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

# Step 3: Attach Policies to Worker Role
echo "3️⃣  Attaching policies to worker role..."

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

# S3 permissions for Lambda deployment package
cat > /tmp/s3-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::$BUCKET_NAME/*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name $LAMBDA_ROLE_NAME \
  --policy-name s3-access-policy \
  --policy-document file:///tmp/s3-policy.json

echo "✅ Policies attached"
echo ""

# Wait for IAM role to propagate
echo "⏳ Waiting for IAM role to propagate (10 seconds)..."
sleep 10

# Step 4: Build Lambda Function
echo "4️⃣  Building Lambda function..."

cd lambda/render-function

# Verify package.json exists
if [ ! -f package.json ]; then
    echo "❌ package.json not found in lambda/render-function"
    exit 1
fi

# Install dependencies
if ! npm install; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Verify @types/aws-lambda is installed
if [ ! -d "node_modules/@types/aws-lambda" ]; then
    echo "Installing @types/aws-lambda..."
    npm install --save-dev @types/aws-lambda@^8.10.130
fi

# Prune dev dependencies
if ! npm prune --production; then
    echo "❌ Failed to prune dev dependencies"
    exit 1
fi

# Build TypeScript
if ! npm run build; then
    echo "❌ TypeScript compilation failed"
    echo "Please check lambda/render-function/index.ts for errors"
    echo "Run 'npm run build' in lambda/render-function for detailed output"
    exit 1
fi

# Create deployment package
echo "📦 Creating deployment package..."
cd dist
if ! zip -r ../function.zip . -x "*.map" > /dev/null; then
    echo "❌ Failed to zip dist directory"
    exit 1
fi
cd ..
if ! zip -r function.zip node_modules -x "*.md" "*.txt" "test/*" "tests/*" "*.ts" "node_modules/@remotion/*/*.md" "node_modules/@remotion/*/test/*" > /dev/null; then
    echo "❌ Failed to zip node_modules"
    exit 1
fi

# Verify package size
ZIP_SIZE=$(stat -f%z function.zip 2>/dev/null || stat -c%s function.zip)
if [ $ZIP_SIZE -gt 52428800 ]; then
    echo "⚠️ Warning: function.zip is $(($ZIP_SIZE / 1048576)) MB (zipped). Unzipped size must be < 250 MB for S3 deployment."
fi

echo "✅ Lambda package created: function.zip"
echo ""

# Step 4.5: Setup Remotion Lambda IAM
echo "4️⃣.5 Setting up Remotion Lambda IAM infrastructure..."

cd ../../

# Ensure Remotion Lambda dependencies are installed
if [ ! -d "node_modules/@remotion/lambda" ]; then
    echo "Installing Remotion Lambda dependencies..."
    npm install @remotion/lambda @remotion/cli @remotion/renderer
    echo "✅ Dependencies installed"
fi

# Use local node_modules binaries
export PATH="$(pwd)/node_modules/.bin:$PATH"

# Get AWS Account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Check if remotion-lambda-role exists
REMOTION_ROLE_EXISTS=$(aws iam get-role --role-name remotion-lambda-role 2>/dev/null && echo "true" || echo "false")

if [ "$REMOTION_ROLE_EXISTS" = "false" ]; then
    echo "Creating remotion-lambda-role..."
    
    # Create trust policy for Remotion Lambda role
    cat > /tmp/remotion-trust-policy.json <<'EOF'
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

    # Create the role
    aws iam create-role \
      --role-name remotion-lambda-role \
      --assume-role-policy-document file:///tmp/remotion-trust-policy.json \
      > /dev/null
    
    echo "✅ remotion-lambda-role created"
else
    echo "✅ remotion-lambda-role already exists"
fi

# Get and attach the inline policy for remotion-lambda-role from Remotion CLI
echo "Configuring remotion-lambda-role inline policy..."
./node_modules/.bin/remotion lambda policies role > /tmp/remotion-lambda-policy.json

aws iam put-role-policy \
  --role-name remotion-lambda-role \
  --policy-name remotion-lambda-policy \
  --policy-document file:///tmp/remotion-lambda-policy.json

echo "✅ remotion-lambda-role inline policy configured"

# Check if remotion-executionrole-policy exists (managed policy for worker Lambda)
EXECUTION_POLICY_EXISTS=$(aws iam get-policy --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy 2>/dev/null && echo "true" || echo "false")

if [ "$EXECUTION_POLICY_EXISTS" = "false" ]; then
    echo "Creating remotion-executionrole-policy (managed policy)..."
    
    # Get the user/execution policy from Remotion CLI
    ./node_modules/.bin/remotion lambda policies user > /tmp/remotion-execution-policy.json
    
    # Create managed policy
    aws iam create-policy \
      --policy-name remotion-executionrole-policy \
      --policy-document file:///tmp/remotion-execution-policy.json \
      > /dev/null
    
    echo "✅ remotion-executionrole-policy created"
else
    echo "✅ remotion-executionrole-policy already exists"
    
    # Optionally update the policy if it exists
    echo "Updating remotion-executionrole-policy..."
    ./node_modules/.bin/remotion lambda policies user > /tmp/remotion-execution-policy.json
    
    # Create a new version (AWS automatically manages version limits)
    aws iam create-policy-version \
      --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy \
      --policy-document file:///tmp/remotion-execution-policy.json \
      --set-as-default \
      2>/dev/null || echo "   (Using existing policy version)"
fi

# Attach execution policy to worker Lambda role
echo "Attaching remotion-executionrole-policy to worker Lambda role..."
aws iam attach-role-policy \
  --role-name $LAMBDA_ROLE_NAME \
  --policy-arn arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy \
  2>/dev/null || echo "   (Policy already attached)"

echo "✅ Worker Lambda role configured"

# Validate the setup
echo "Validating Remotion policies..."
if ./node_modules/.bin/remotion lambda policies validate --region $REGION 2>&1 | grep -q "success\|valid"; then
    echo "✅ Remotion policies validated successfully"
else
    echo "⚠️  Policy validation completed (warnings are normal for new setups)"
fi

# Wait for policies to propagate globally
echo "⏳ Waiting for IAM policies to propagate globally (15 seconds)..."
sleep 15

echo ""

# Step 5: Deploy Remotion Lambda
echo "5️⃣  Deploying Remotion Lambda function..."

REMOTION_FUNCTION_NAME=$(./node_modules/.bin/remotion lambda functions ls --region $REGION 2>/dev/null | grep -oP 'remotion-render-\S+' | head -1 || echo "")

if [ -z "$REMOTION_FUNCTION_NAME" ]; then
    echo "Deploying Remotion Lambda function..."
    
    if ./node_modules/.bin/remotion lambda functions deploy --region $REGION; then
        REMOTION_FUNCTION_NAME=$(./node_modules/.bin/remotion lambda functions ls --region $REGION | grep -oP 'remotion-render-\S+' | head -1)
        echo "✅ Remotion Lambda function deployed: $REMOTION_FUNCTION_NAME"
    else
        echo "❌ Failed to deploy Remotion Lambda function"
        echo "Please check:"
        echo "  1. Run: ./node_modules/.bin/remotion lambda policies validate --region $REGION"
        echo "  2. Check IAM permissions"
        echo "  3. View full error above"
        exit 1
    fi
else
    echo "✅ Remotion Lambda function already exists: $REMOTION_FUNCTION_NAME"
fi

echo ""

# Step 5.5: Deploy Remotion Site
echo "5️⃣.5 Deploying Remotion site..."

# Check if site already exists
SITE_CHECK=$(./node_modules/.bin/remotion lambda sites ls --region $REGION 2>/dev/null || echo "")
REMOTION_SERVE_URL=$(echo "$SITE_CHECK" | grep -oP 'https://\S+' | head -1)

if [ -z "$REMOTION_SERVE_URL" ]; then
    echo "Deploying Remotion site from src/remotion/index.tsx..."
    
    # Deploy site pointing to src/remotion/index.tsx
    if ./node_modules/.bin/remotion lambda sites create src/remotion/index.tsx --region $REGION --log=verbose; then
        # Get the newly created site URL
        SITE_CHECK=$(./node_modules/.bin/remotion lambda sites ls --region $REGION 2>/dev/null || echo "")
        REMOTION_SERVE_URL=$(echo "$SITE_CHECK" | grep -oP 'https://\S+' | head -1)
        echo "✅ Remotion site deployed: $REMOTION_SERVE_URL"
    else
        echo "❌ Failed to deploy Remotion site"
        echo "Please check:"
        echo "  1. Ensure src/remotion/index.tsx exists and is a valid entry point"
        echo "  2. Check for TypeScript/JSX syntax errors"
        echo "  3. Verify remotion.config.ts is properly configured"
        echo "  4. Run with verbose logging: ./node_modules/.bin/remotion lambda sites create src/remotion/index.tsx --region $REGION --log=verbose"
        exit 1
    fi
    
    # Navigate to lambda function directory for next steps
    cd lambda/render-function
else
    echo "✅ Remotion site already exists: $REMOTION_SERVE_URL"
    # Navigate to lambda function directory for next steps
    cd lambda/render-function
fi

echo ""

# Step 6: Create/Update Lambda Worker Function
echo "6️⃣  Deploying Lambda worker function..."

# Check if function exists
FUNCTION_EXISTS=$(aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --region $REGION 2>/dev/null && echo "true" || echo "false")

# Prepare environment variables (exclude AWS_REGION)
ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL"
if [ -n "$WEBHOOK_SECRET" ]; then
    ENV_VARS="$ENV_VARS,WEBHOOK_SECRET=$WEBHOOK_SECRET"
fi
ENV_VARS="$ENV_VARS}"

# Create S3 bucket for deployment package
aws s3 mb s3://$BUCKET_NAME --region $REGION 2>/dev/null || echo "S3 bucket already exists or accessible"
aws s3 cp function.zip s3://$BUCKET_NAME/function.zip

if [ "$FUNCTION_EXISTS" = "false" ]; then
    echo "Creating new Lambda function..."
    
    aws lambda create-function \
      --function-name $LAMBDA_FUNCTION_NAME \
      --runtime nodejs18.x \
      --role $ROLE_ARN \
      --handler index.handler \
      --code S3Bucket=$BUCKET_NAME,S3Key=function.zip \
      --timeout 900 \
      --memory-size 2048 \
      --region $REGION \
      --environment "$ENV_VARS" \
      > /dev/null
    
    echo "✅ Lambda function created"
else
    echo "Updating existing Lambda function..."
    
    aws lambda update-function-code \
      --function-name $LAMBDA_FUNCTION_NAME \
      --s3-bucket $BUCKET_NAME \
      --s3-key function.zip \
      --region $REGION \
      > /dev/null
    
    aws lambda update-function-configuration \
      --function-name $LAMBDA_FUNCTION_NAME \
      --timeout 900 \
      --memory-size 2048 \
      --environment "$ENV_VARS" \
      --region $REGION \
      > /dev/null
    
    echo "✅ Lambda function updated"
fi

# Clean up S3 object
aws s3 rm s3://$BUCKET_NAME/function.zip
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
if grep -q "REMOTION_SQS_QUEUE_URL" .env; then
    sed -i.bak "s|REMOTION_SQS_QUEUE_URL=.*|REMOTION_SQS_QUEUE_URL=$QUEUE_URL|" .env
else
    echo "REMOTION_SQS_QUEUE_URL=$QUEUE_URL" >> .env
fi

if grep -q "REMOTION_LAMBDA_FUNCTION_NAME" .env; then
    sed -i.bak "s|REMOTION_LAMBDA_FUNCTION_NAME=.*|REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME|" .env
else
    echo "REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME" >> .env
fi

if grep -q "REMOTION_SERVE_URL" .env; then
    sed -i.bak "s|REMOTION_SERVE_URL=.*|REMOTION_SERVE_URL=$REMOTION_SERVE_URL|" .env
else
    echo "REMOTION_SERVE_URL=$REMOTION_SERVE_URL" >> .env
fi

# Add WEBHOOK_SECRET if not present
if ! grep -q "WEBHOOK_SECRET" .env; then
    echo "WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
fi

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
echo "   Lambda Worker: $LAMBDA_FUNCTION_NAME"
echo "   Remotion Function: $REMOTION_FUNCTION_NAME"
echo "   Remotion Site: $REMOTION_SERVE_URL"
echo ""
echo "🔧 Next Steps:"
echo "   1. Verify WEBHOOK_SECRET in .env"
echo "   2. Set API_BASE_URL in .env to your public API URL"
echo "   3. Restart your API server"
echo "   4. Test: ./test-export.sh <project_id>"
echo ""
echo "📊 Monitor:"
echo "   SQS Messages: aws sqs get-queue-attributes --queue-url $QUEUE_URL --attribute-names All"
echo "   Lambda Logs: aws logs tail /aws/lambda/$LAMBDA_FUNCTION_NAME --follow"
echo "   List Renders: ./node_modules/.bin/remotion lambda renders ls --region $REGION"
echo ""
echo "🗑️  Cleanup:"
echo "   Delete Queue: aws sqs delete-queue --queue-url $QUEUE_URL --region $REGION"
echo "   Delete Worker: aws lambda delete-function --function-name $LAMBDA_FUNCTION_NAME --region $REGION"
echo "   Delete Role: aws iam delete-role --role-name $LAMBDA_ROLE_NAME"
echo "   Delete S3 Bucket: aws s3 rb s3://$BUCKET_NAME --force"
echo "   Cleanup Remotion: ./node_modules/.bin/remotion lambda functions rmall --region $REGION"
echo "   Cleanup Sites: ./node_modules/.bin/remotion lambda sites rmall --region $REGION"
echo ""
echo "════════════════════════════════════════════════════════════════"