#!/bin/bash

# Setup SQS Queue and Lambda Function for Remotion Rendering
# Usage:
#   ./setup.sh                    # Full setup (first time)
#   ./setup.sh --update-only      # Only update Lambda code (fast)
#   ./setup.sh --fast             # Alias for --update-only
#   ./setup.sh --region=us-west-2 # Override region

set -e

# === CONFIG ===
REGION="${AWS_REGION:-us-east-1}"
QUEUE_NAME="remotion-render-queue"
LAMBDA_FUNCTION_NAME="remotion-render-worker"
LAMBDA_ROLE_NAME="remotion-render-lambda-role"
UPDATE_ONLY=false

# === PARSE ARGUMENTS ===
for arg in "$@"; do
  case $arg in
    --update-only|--fast)
      UPDATE_ONLY=true
      shift
      ;;
    --region=*)
      REGION="${arg#*=}"
      shift
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--update-only|--fast] [--region=us-east-1]"
      exit 1
      ;;
  esac
done

echo "Mode: $( [ "$UPDATE_ONLY" = true ] && echo "UPDATE ONLY (Lambda code)" || echo "FULL INFRA SETUP" )"
echo "Region: $REGION"
echo ""

# === VALIDATE REGION ===
VALID_REGIONS=("eu-central-1" "eu-central-2" "eu-west-1" "eu-west-2" "eu-west-3" "eu-south-1" "eu-north-1" "us-east-1" "us-east-2" "us-west-1" "us-west-2" "af-south-1" "ap-south-1" "ap-east-1" "ap-southeast-1" "ap-southeast-2" "ap-northeast-1" "ap-northeast-2" "ap-northeast-3" "ap-southeast-4" "ap-southeast-5" "ca-central-1" "me-south-1" "sa-east-1")
if [[ ! " ${VALID_REGIONS[@]} " =~ " ${REGION} " ]]; then
  echo "Invalid AWS region: $REGION"
  echo "Must be one of: ${VALID_REGIONS[*]}"
  exit 1
fi

# === FAST UPDATE MODE ===
if [ "$UPDATE_ONLY" = true ]; then
  echo "Updating Lambda: $LAMBDA_FUNCTION_NAME"

  [ -f .env ] && source .env
  [ -z "$REMOTION_LAMBDA_FUNCTION_NAME" ] || [ -z "$REMOTION_SERVE_URL" ] && {
    echo "Missing vars in .env. Run full setup first."
    exit 1
  }

  cd lambda/render-function
  npm ci --silent
  npm run build
  cd dist && zip -r ../function.zip . -x "*.map" > /dev/null
  cd .. && zip -r function.zip node_modules -x "*.md" "*.txt" "test/*" "tests/*" "*.ts" > /dev/null
  cd ../../

  # Reuse or create bucket
  if [ -z "$BUCKET_NAME" ] || ! aws s3 ls "s3://$BUCKET_NAME" > /dev/null 2>&1; then
    BUCKET_NAME="remotion-lambda-deployment-$(date +%s)"
    aws s3 mb "s3://$BUCKET_NAME" --region "$REGION" > /dev/null
    echo "Created temp bucket: $BUCKET_NAME"
  else
    echo "Using existing bucket: $BUCKET_NAME"
  fi

  # Upload
  echo "Uploading function.zip to S3..."
  aws s3 cp lambda/render-function/function.zip "s3://$BUCKET_NAME/function.zip" --region "$REGION"

  # Update code
  echo "Updating Lambda code..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --s3-bucket "$BUCKET_NAME" \
    --s3-key function.zip \
    --region "$REGION" > /dev/null

  echo "Waiting 15s for code update to stabilize..."
  sleep 15

  # Update config with retry
  ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_LAMBDA_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL"
  [ -n "$WEBHOOK_SECRET" ] && ENV_VARS="$ENV_VARS,WEBHOOK_SECRET=$WEBHOOK_SECRET"
  ENV_VARS="$ENV_VARS}"

  echo "Updating environment variables..."
  for i in {1..6}; do
    if aws lambda update-function-configuration \
      --function-name "$LAMBDA_FUNCTION_NAME" \
      --environment "$ENV_VARS" \
      --region "$REGION" > /dev/null 2>&1; then
      echo "   Config updated successfully."
      break
    else
      echo "   Conflict: update in progress. Retrying in 10s... ($i/6)"
      sleep 10
    fi
  done

  if [ $i -eq 7 ]; then
    echo "Failed after 6 retries."
    exit 1
  fi

  # Cleanup
  aws s3 rm "s3://$BUCKET_NAME/function.zip" 2>/dev/null || true
  rm -f lambda/render-function/function.zip

  echo ""
  echo "DEPLOY SUCCESSFUL!"
  echo "   Function: $LAMBDA_FUNCTION_NAME"
  echo "   Monitor: aws logs tail /aws/lambda/$LAMBDA_FUNCTION_NAME --follow"
  exit 0
fi

# === FULL SETUP STARTS HERE ===
echo "Starting full infrastructure setup..."

# Step 1: Create SQS Queue
echo "1. Creating SQS Queue: $QUEUE_NAME..."
QUEUE_URL=$(aws sqs create-queue \
  --queue-name "$QUEUE_NAME" \
  --region "$REGION" \
  --attributes '{
    "MessageRetentionPeriod": "86400",
    "VisibilityTimeout": "900",
    "ReceiveMessageWaitTimeSeconds": "20"
  }' \
  --query 'QueueUrl' --output text 2>/dev/null || \
  aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query 'QueueUrl' --output text)

QUEUE_ARN=$(aws sqs get-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attribute-names QueueArn \
  --region "$REGION" \
  --query 'Attributes.QueueArn' --output text)

echo "   Queue URL: $QUEUE_URL"
echo "   ARN: $QUEUE_ARN"
echo ""

# Step 2: Create IAM Role
echo "2. Creating IAM Role: $LAMBDA_ROLE_NAME..."
cat > /tmp/trust-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Service": "lambda.amazonaws.com" },
    "Action": "sts:AssumeRole"
  }]
}
EOF

ROLE_ARN=$(aws iam create-role \
  --role-name "$LAMBDA_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/trust-policy.json \
  --query 'Role.Arn' --output text 2>/dev/null || \
  aws iam get-role --role-name "$LAMBDA_ROLE_NAME" --query 'Role.Arn' --output text)

echo "   Role ARN: $ROLE_ARN"
echo ""

# Step 3: Attach Policies
echo "3. Attaching policies..."
aws iam attach-role-policy \
  --role-name "$LAMBDA_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true

cat > /tmp/sqs-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sqs:ReceiveMessage","sqs:DeleteMessage","sqs:GetQueueAttributes","sqs:ChangeMessageVisibility"],
    "Resource": "$QUEUE_ARN"
  }]
}
EOF
aws iam put-role-policy --role-name "$LAMBDA_ROLE_NAME" --policy-name sqs-policy --policy-document file:///tmp/sqs-policy.json

echo "   Policies attached"
echo "   Waiting 10s for IAM..."
sleep 10

# Step 4: Build Lambda Package
echo "4. Building Lambda package..."
cd lambda/render-function
npm install
npm run build
cd dist
zip -r ../function.zip . -x "*.map" > /dev/null
cd ..
zip -r function.zip node_modules -x "*.md" "*.txt" "test/*" "tests/*" "*.ts" > /dev/null
cd ../../

# Step 4.5: Remotion IAM & Deploy
echo "4.5 Setting up Remotion Lambda..."
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Create role
if ! aws iam get-role --role-name remotion-lambda-role > /dev/null 2>&1; then
  aws iam create-role --role-name remotion-lambda-role --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' > /dev/null
fi

./node_modules/.bin/remotion lambda policies role > /tmp/remotion-lambda-policy.json
aws iam put-role-policy --role-name remotion-lambda-role --policy-name remotion-lambda-policy --policy-document file:///tmp/remotion-lambda-policy.json

# Execution policy
if ! aws iam get-policy --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy" > /dev/null 2>&1; then
  ./node_modules/.bin/remotion lambda policies user > /tmp/policy.json
  aws iam create-policy --policy-name remotion-executionrole-policy --policy-document file:///tmp/policy.json > /dev/null
else
  ./node_modules/.bin/remotion lambda policies user > /tmp/policy.json
  aws iam create-policy-version --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy" --policy-document file:///tmp/policy.json --set-as-default 2>/dev/null || true
fi

aws iam attach-role-policy --role-name "$LAMBDA_ROLE_NAME" --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy" 2>/dev/null || true

echo "   Validating permissions..."
if ! ./node_modules/.bin/remotion lambda policies validate --region "$REGION" --log=verbose | grep -q "All checks passed"; then
  echo "Permission validation failed. Run manually:"
  echo "./node_modules/.bin/remotion lambda policies validate --region $REGION --log=verbose"
  exit 1
fi
sleep 15

# Step 5: Deploy Remotion Function
echo "5. Deploying Remotion Lambda function..."
REMOTION_FUNCTION_NAME=$(./node_modules/.bin/remotion lambda functions ls --region "$REGION" 2>/dev/null | grep 'remotion-render-' | awk '{print $1}' | head -1 || echo "")

if [ -z "$REMOTION_FUNCTION_NAME" ]; then
  OUTPUT=$(./node_modules/.bin/remotion lambda functions deploy --region "$REGION" --log=verbose)
  REMOTION_FUNCTION_NAME=$(echo "$OUTPUT" | grep -o 'remotion-render-[a-z0-9]\+' | head -1)
fi
[ -z "$REMOTION_FUNCTION_NAME" ] && { echo "Failed to get Remotion function name"; exit 1; }
echo "   Function: $REMOTION_FUNCTION_NAME"

# Step 5.5: Deploy Site
echo "5.5 Deploying Remotion site..."
REMOTION_SERVE_URL=$(./node_modules/.bin/remotion lambda sites ls --region "$REGION" 2>/dev/null | grep 'https://' | awk '{print $1}' | head -1 || echo "")

if [ -z "$REMOTION_SERVE_URL" ]; then
  OUTPUT=$(./node_modules/.bin/remotion lambda sites create src/remotion/index.tsx --region "$REGION" --log=verbose)
  REMOTION_SERVE_URL=$(echo "$OUTPUT" | grep -o 'https://remotionlambda-[^ ]\+' | head -1)
fi
[ -z "$REMOTION_SERVE_URL" ] && { echo "Failed to deploy site"; exit 1; }
echo "   Site: $REMOTION_SERVE_URL"

cd lambda/render-function

# Step 6: Deploy Worker Lambda
echo "6. Deploying worker Lambda..."
aws s3 mb "s3://$BUCKET_NAME" --region "$REGION" 2>/dev/null || true
aws s3 cp function.zip "s3://$BUCKET_NAME/function.zip"

ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL"
[ -n "$WEBHOOK_SECRET" ] && ENV_VARS="$ENV_VARS,WEBHOOK_SECRET=$WEBHOOK_SECRET"
ENV_VARS="$ENV_VARS}"

if ! aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" > /dev/null 2>&1; then
  aws lambda create-function \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime nodejs18.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --code S3Bucket="$BUCKET_NAME",S3Key=function.zip \
    --timeout 900 \
    --memory-size 2048 \
    --environment "$ENV_VARS" \
    --region "$REGION" > /dev/null
else
  aws lambda update-function-code --function-name "$LAMBDA_FUNCTION_NAME" --s3-bucket "$BUCKET_NAME" --s3-key function.zip --region "$REGION" > /dev/null
  aws lambda update-function-configuration --function-name "$LAMBDA_FUNCTION_NAME" --environment "$ENV_VARS" --region "$REGION" > /dev/null
fi

aws s3 rm "s3://$BUCKET_NAME/function.zip" 2>/dev/null || true

# Step 7: SQS Trigger
echo "7. Configuring SQS trigger..."
LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" --query 'Configuration.FunctionArn' --output text)
if ! aws lambda list-event-source-mappings --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" --query "EventSourceMappings[?EventSourceArn=='$QUEUE_ARN'].UUID" --output text | grep -q .; then
  aws lambda create-event-source-mapping \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --event-source-arn "$QUEUE_ARN" \
    --batch-size 1 \
    --function-response-types ReportBatchItemFailures \
    --region "$REGION" > /dev/null
fi

# Step 8: Update .env
echo "8. Updating .env..."
cd ../../
[ ! -f .env ] && cp .env.example .env 2>/dev/null || touch .env

update_env() { grep -q "^$1=" .env && sed -i.bak "s|^$1=.*|$1=$2|" .env || echo "$1=$2" >> .env; }
update_env REMOTION_SQS_QUEUE_URL "$QUEUE_URL"
update_env REMOTION_LAMBDA_FUNCTION_NAME "$REMOTION_FUNCTION_NAME"
update_env REMOTION_SERVE_URL "$REMOTION_SERVE_URL"
update_env REMOTION_WORKER_FUNCTION_NAME "$LAMBDA_FUNCTION_NAME"
! grep -q WEBHOOK_SECRET .env && echo "WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
rm -f .env.bak

echo ""
echo "SETUP COMPLETE!"
echo "   Queue: $QUEUE_URL"
echo "   Worker: $LAMBDA_FUNCTION_NAME"
echo "   Remotion: $REMOTION_FUNCTION_NAME"
echo "   Site: $REMOTION_SERVE_URL"
echo ""
echo "Next: ./setup.sh --update-only  # After code changes"
echo "Test:  ./test-export.sh <project_id>"
echo "Logs:  aws logs tail /aws/lambda/$LAMBDA_FUNCTION_NAME --follow"