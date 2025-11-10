#!/bin/bash

# Remotion + SQS + Step Functions + Lambda Setup
# ENTERPRISE SOLUTION: Serial render execution with Step Functions
# Run: ./setup.sh          → Full setup
# Run: ./setup.sh --update-only → Fast deploy

set -e

# === CONFIG ===
REGION="${AWS_REGION:-us-east-1}"
QUEUE_NAME="remotion-render-queue"
LAMBDA_FUNCTION_NAME="remotion-render-worker"
LAMBDA_ROLE_NAME="remotion-render-lambda-role"
STATE_MACHINE_NAME="remotion-render-workflow"
STATE_MACHINE_ROLE_NAME="remotion-state-machine-role"
PERMANENT_BUCKET="remotion-lambda-code-prod"
UPDATE_ONLY=false
USE_FIFO=false

# === PARSE ARGS ===
for arg in "$@"; do
  case $arg in
    --update-only|--fast) UPDATE_ONLY=true ;;
    --region=*) REGION="${arg#*=}" ;;
    --fifo) USE_FIFO=true ;;
    *) echo "Usage: $0 [--update-only] [--region=us-east-1] [--fifo]"; exit 1 ;;
  esac
done

echo "Mode: $( [ "$UPDATE_ONLY" = true ] && echo "UPDATE ONLY" || echo "FULL SETUP" )"
echo "Region: $REGION"
echo "FIFO Queue: $( [ "$USE_FIFO" = true ] && echo "YES (Serial)" || echo "NO (Parallel)" )"
echo ""

# === VALIDATE REGION ===
VALID_REGIONS=("us-east-1" "us-east-2" "us-west-1" "us-west-2" "eu-west-1" "eu-central-1" "ap-southeast-1" "ap-northeast-1")
if ! echo "${VALID_REGIONS[@]}" | grep -qw "$REGION"; then
  echo "Invalid region: $REGION"; exit 1
fi

# === LOAD .env ===
[ -f .env ] && source .env

# === FAST UPDATE MODE ===
if [ "$UPDATE_ONLY" = true ]; then
  echo "Updating Lambda and State Machine..."

  [ -z "$REMOTION_LAMBDA_FUNCTION_NAME" ] && { echo "Missing REMOTION_LAMBDA_FUNCTION_NAME in .env"; exit 1; }
  [ -z "$REMOTION_SERVE_URL" ] && { echo "Missing REMOTION_SERVE_URL in .env"; exit 1; }
  [ -z "$STATE_MACHINE_ARN" ] && { echo "Missing STATE_MACHINE_ARN in .env"; exit 1; }

  cd lambda/render-function
  npm ci --silent
  npm run build
  (cd dist && zip -r ../function.zip . -x "*.map" > /dev/null)
  zip -r function.zip node_modules -x "*.md" "*.txt" "test/*" "tests/*" "*.ts" > /dev/null
  cd ../../

  BUCKET_NAME="${BUCKET_NAME:-$PERMANENT_BUCKET}"
  if ! aws s3 ls "s3://$BUCKET_NAME" > /dev/null 2>&1; then
    echo "Creating bucket: $BUCKET_NAME"
    aws s3 mb "s3://$BUCKET_NAME" --region "$REGION"
  fi

  echo "Uploading function.zip..."
  aws s3 cp lambda/render-function/function.zip "s3://$BUCKET_NAME/function.zip" --region "$REGION"

  echo "Updating Lambda code..."
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --s3-bucket "$BUCKET_NAME" \
    --s3-key function.zip \
    --region "$REGION" > /dev/null

  sleep 15

  ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_LAMBDA_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL,STATE_MACHINE_ARN=$STATE_MACHINE_ARN,QUEUE_URL=$REMOTION_SQS_QUEUE_URL"
  [ -n "$WEBHOOK_SECRET" ] && ENV_VARS="$ENV_VARS,WEBHOOK_SECRET=$WEBHOOK_SECRET"
  [ -n "$WEBHOOK_URL" ] && ENV_VARS="$ENV_VARS,WEBHOOK_URL=$WEBHOOK_URL"
  ENV_VARS="$ENV_VARS}"

  echo "Updating Lambda config..."
  for i in {1..6}; do
    if aws lambda update-function-configuration \
      --function-name "$LAMBDA_FUNCTION_NAME" \
      --environment "$ENV_VARS" \
      --region "$REGION" > /dev/null 2>&1; then
      echo "   Success."
      break
    fi
    echo "   Retrying... ($i/6)"
    sleep 10
  done
  [ $i -eq 7 ] && { echo "Config update failed"; exit 1; }

  # Update State Machine
  echo "Updating State Machine..."
  if [ -f "infrastructure/state-machine.json" ]; then
    aws stepfunctions update-state-machine \
      --state-machine-arn "$STATE_MACHINE_ARN" \
      --definition file://infrastructure/state-machine.json \
      --region "$REGION" > /dev/null
    echo "   State Machine updated"
  fi

  rm -f lambda/render-function/function.zip
  echo "DEPLOYED: $LAMBDA_FUNCTION_NAME"
  exit 0
fi

# === FULL SETUP ===
echo "Starting full setup with Step Functions..."

# Get AWS Account ID
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "AWS Account: $AWS_ACCOUNT_ID"

# 1. SQS Queue (Standard or FIFO)
echo "1. Creating SQS Queue..."
if [ "$USE_FIFO" = true ]; then
  QUEUE_NAME="${QUEUE_NAME}.fifo"
  QUEUE_URL=$(aws sqs create-queue \
    --queue-name "$QUEUE_NAME" \
    --region "$REGION" \
    --attributes '{
      "MessageRetentionPeriod":"86400",
      "VisibilityTimeout":"900",
      "FifoQueue":"true",
      "ContentBasedDeduplication":"true"
    }' \
    --query 'QueueUrl' --output text 2>/dev/null || \
    aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query 'QueueUrl' --output text)
else
  QUEUE_URL=$(aws sqs create-queue \
    --queue-name "$QUEUE_NAME" \
    --region "$REGION" \
    --attributes '{"MessageRetentionPeriod":"86400","VisibilityTimeout":"900"}' \
    --query 'QueueUrl' --output text 2>/dev/null || \
    aws sqs get-queue-url --queue-name "$QUEUE_NAME" --region "$REGION" --query 'QueueUrl' --output text)
fi

QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text --region "$REGION")
echo "   Queue: $QUEUE_URL"
echo "   ARN: $QUEUE_ARN"

# 2. Dead Letter Queue
echo "2. Creating Dead Letter Queue..."
DLQ_NAME="${QUEUE_NAME}-dlq"
DLQ_URL=$(aws sqs create-queue \
  --queue-name "$DLQ_NAME" \
  --region "$REGION" \
  --query 'QueueUrl' --output text 2>/dev/null || \
  aws sqs get-queue-url --queue-name "$DLQ_NAME" --region "$REGION" --query 'QueueUrl' --output text)

DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query 'Attributes.QueueArn' --output text --region "$REGION")

# Configure redrive policy
aws sqs set-queue-attributes \
  --queue-url "$QUEUE_URL" \
  --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" \
  --region "$REGION"
echo "   DLQ: $DLQ_URL"

# 3. Lambda IAM Role
echo "3. Creating Lambda IAM Role..."
cat > /tmp/lambda-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "lambda.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

LAMBDA_ROLE_ARN=$(aws iam create-role \
  --role-name "$LAMBDA_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/lambda-trust.json \
  --query 'Role.Arn' --output text 2>/dev/null || \
  aws iam get-role --role-name "$LAMBDA_ROLE_NAME" --query 'Role.Arn' --output text)
echo "   Lambda Role: $LAMBDA_ROLE_ARN"

# 4. Step Functions IAM Role
echo "4. Creating Step Functions IAM Role..."
cat > /tmp/sfn-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "states.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
EOF

STATE_MACHINE_ROLE_ARN=$(aws iam create-role \
  --role-name "$STATE_MACHINE_ROLE_NAME" \
  --assume-role-policy-document file:///tmp/sfn-trust.json \
  --query 'Role.Arn' --output text 2>/dev/null || \
  aws iam get-role --role-name "$STATE_MACHINE_ROLE_NAME" --query 'Role.Arn' --output text)
echo "   Step Functions Role: $STATE_MACHINE_ROLE_ARN"

# 5. Attach Lambda Policies
echo "5. Attaching Lambda policies..."
aws iam attach-role-policy --role-name "$LAMBDA_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole 2>/dev/null || true

# Lambda SQS policy
cat > /tmp/lambda-sqs.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:ChangeMessageVisibility"
    ],
    "Resource": "$QUEUE_ARN"
  }]
}
EOF
aws iam put-role-policy --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name lambda-sqs-access --policy-document file:///tmp/lambda-sqs.json

# Lambda Step Functions policy
cat > /tmp/lambda-sfn.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "states:StartExecution",
      "states:DescribeExecution"
    ],
    "Resource": "arn:aws:states:$REGION:$AWS_ACCOUNT_ID:stateMachine:$STATE_MACHINE_NAME"
  }]
}
EOF
aws iam put-role-policy --role-name "$LAMBDA_ROLE_NAME" \
  --policy-name lambda-sfn-access --policy-document file:///tmp/lambda-sfn.json

# 6. Attach Step Functions Policies
echo "6. Attaching Step Functions policies..."
cat > /tmp/sfn-lambda.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "lambda:InvokeFunction"
    ],
    "Resource": "arn:aws:lambda:$REGION:$AWS_ACCOUNT_ID:function:$LAMBDA_FUNCTION_NAME"
  }]
}
EOF
aws iam put-role-policy --role-name "$STATE_MACHINE_ROLE_NAME" \
  --policy-name sfn-lambda-invoke --policy-document file:///tmp/sfn-lambda.json

# CloudWatch Logs for Step Functions
aws iam attach-role-policy --role-name "$STATE_MACHINE_ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess 2>/dev/null || true

sleep 10

# 7. Remotion IAM Setup
echo "7. Setting up Remotion IAM..."
if ! aws iam get-role --role-name remotion-lambda-role > /dev/null 2>&1; then
  aws iam create-role --role-name remotion-lambda-role \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' > /dev/null
fi

./node_modules/.bin/remotion lambda policies role > /tmp/remotion-policy.json 2>/dev/null || true
aws iam put-role-policy --role-name remotion-lambda-role \
  --policy-name remotion-policy --policy-document file:///tmp/remotion-policy.json 2>/dev/null || true

if ! aws iam get-policy --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy" > /dev/null 2>&1; then
  ./node_modules/.bin/remotion lambda policies user > /tmp/remotion-user-policy.json 2>/dev/null || true
  aws iam create-policy --policy-name remotion-executionrole-policy \
    --policy-document file:///tmp/remotion-user-policy.json > /dev/null 2>&1 || true
fi

aws iam attach-role-policy --role-name "$LAMBDA_ROLE_NAME" \
  --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/remotion-executionrole-policy" 2>/dev/null || true

sleep 10

# 8. Deploy Remotion Function
echo "8. Deploying Remotion function..."
if ./node_modules/.bin/remotion lambda functions ls --region "$REGION" 2>/dev/null | grep -q "remotion-render-"; then
  REMOTION_FUNCTION_NAME=$(./node_modules/.bin/remotion lambda functions ls --region "$REGION" | grep -oE "remotion-render-[a-z0-9-]+" | head -1 | sed 's/-mem[0-9]\+mb-disk[0-9]\+mb-[0-9]\+sec//')
  echo "   Found existing: $REMOTION_FUNCTION_NAME"
else
  echo "   Deploying new function..."
  DEPLOY_OUTPUT=$(./node_modules/.bin/remotion lambda functions deploy --region "$REGION" --log=verbose 2>&1)
  echo "$DEPLOY_OUTPUT"
  REMOTION_FUNCTION_NAME=$(echo "$DEPLOY_OUTPUT" | grep -oE "remotion-render-[a-z0-9-]+" | head -1 | sed 's/-mem[0-9]\+mb-disk[0-9]\+mb-[0-9]\+sec//')
fi

[ -z "$REMOTION_FUNCTION_NAME" ] && { echo "Failed to get Remotion function name"; exit 1; }
echo "   Using: $REMOTION_FUNCTION_NAME"


# 9. Deploy Remotion Site
echo "9. Deploying Remotion site..."
REMOTION_SERVE_URL=$(./node_modules/.bin/remotion lambda sites ls --region "$REGION" 2>/dev/null | grep -o 'https://remotionlambda-[^ ]\+' | head -1 || echo "")
if [ -z "$REMOTION_SERVE_URL" ]; then
  OUTPUT=$(./node_modules/.bin/remotion lambda sites create src/remotion/index.tsx --region "$REGION" --log=verbose)
  REMOTION_SERVE_URL=$(echo "$OUTPUT" | grep -o 'https://remotionlambda-[^ ]\+' | head -1)
fi
[ -z "$REMOTION_SERVE_URL" ] && { echo "Site deploy failed"; exit 1; }
echo "   $REMOTION_SERVE_URL"

# 10. Build Lambda Package
echo "10. Building Lambda package..."
cd lambda/render-function
npm install
npm run build
(cd dist && zip -r ../function.zip . -x "*.map" > /dev/null)
zip -r function.zip node_modules -x "*.md" "*.txt" "test/*" "tests/*" "*.ts" > /dev/null
cd ../../

# 11. Upload to S3
echo "11. Uploading to S3..."
BUCKET_NAME="$PERMANENT_BUCKET"
if ! aws s3 ls "s3://$BUCKET_NAME" > /dev/null 2>&1; then
  aws s3 mb "s3://$BUCKET_NAME" --region "$REGION"
fi
aws s3 cp lambda/render-function/function.zip "s3://$BUCKET_NAME/function.zip" --region "$REGION"

# 12. Deploying Lambda worker...
echo "12. Deploying Lambda worker..."

ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=\"${REMOTION_FUNCTION_NAME}\",REMOTION_SERVE_URL=\"${REMOTION_SERVE_URL}\",QUEUE_URL=\"${QUEUE_URL}\",AWS_REGION_OVERRIDE=\"${REGION}\""
[ -n "$WEBHOOK_SECRET" ] && ENV_VARS="${ENV_VARS},WEBHOOK_SECRET=\"${WEBHOOK_SECRET}\""
[ -n "$WEBHOOK_URL" ] && ENV_VARS="${ENV_VARS},WEBHOOK_URL=\"${WEBHOOK_URL}\""
ENV_VARS="${ENV_VARS}}"

if ! aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" > /dev/null 2>&1; then
  aws lambda create-function \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --runtime nodejs20.x \
    --role "$LAMBDA_ROLE_ARN" \
    --handler index.handler \
    --code S3Bucket="$BUCKET_NAME",S3Key=function.zip \
    --timeout 900 \
    --memory-size 1024 \
    --environment "$ENV_VARS" \
    --region "$REGION" > /dev/null
  sleep 10
else
  aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --s3-bucket "$BUCKET_NAME" --s3-key function.zip \
    --region "$REGION" > /dev/null
  sleep 10
fi

LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA_FUNCTION_NAME" \
  --region "$REGION" --query 'Configuration.FunctionArn' --output text)
echo "   Lambda ARN: $LAMBDA_ARN"


# 13. Create State Machine
echo "13. Creating Step Functions state machine..."
mkdir -p infrastructure

cat > infrastructure/state-machine.json <<EOF
{
  "Comment": "Remotion Render Workflow with Serial Execution",
  "StartAt": "TriggerRender",
  "States": {
    "TriggerRender": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "$LAMBDA_ARN",
        "Payload": {
          "action": "start",
          "exportId.$": "$.exportId",
          "projectId.$": "$.projectId",
          "userId.$": "$.userId",
          "renderConfig.$": "$.renderConfig"
        }
      },
      "ResultPath": "$.renderResult",
      "ResultSelector": {
        "statusCode.$": "$.StatusCode",
        "payload.$": "$.Payload"
      },
      "Next": "WaitForRender",
      "Retry": [{
        "ErrorEquals": ["States.TaskFailed", "Lambda.ServiceException"],
        "IntervalSeconds": 10,
        "MaxAttempts": 3,
        "BackoffRate": 2.0
      }],
      "Catch": [{
        "ErrorEquals": ["States.ALL"],
        "ResultPath": "$.error",
        "Next": "RenderFailed"
      }]
    },
    "WaitForRender": {
      "Type": "Wait",
      "Seconds": 30,
      "Next": "CheckRenderStatus"
    },
    "CheckRenderStatus": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "$LAMBDA_ARN",
        "Payload": {
          "action": "check",
          "renderId.$": "$.renderResult.payload.renderId",
          "bucketName.$": "$.renderResult.payload.bucketName",
          "exportId.$": "$.exportId"
        }
      },
      "ResultPath": "$.statusResult",
      "ResultSelector": {
        "statusCode.$": "$.StatusCode",
        "payload.$": "$.Payload"
      },
      "Next": "IsRenderComplete",
      "Retry": [{
        "ErrorEquals": ["Lambda.TooManyRequestsException"],
        "IntervalSeconds": 5,
        "MaxAttempts": 10,
        "BackoffRate": 2.0
      }]
    },
    "IsRenderComplete": {
      "Type": "Choice",
      "Choices": [
        {
          "Variable": "$.statusResult.payload.done",
          "BooleanEquals": true,
          "Next": "RenderSuccess"
        },
        {
          "Variable": "$.statusResult.payload.failed",
          "BooleanEquals": true,
          "Next": "RenderFailed"
        }
      ],
      "Default": "WaitForRender"
    },
    "RenderSuccess": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "$LAMBDA_ARN",
        "Payload": {
          "action": "complete",
          "exportId.$": "$.exportId",
          "projectId.$": "$.projectId",
          "userId.$": "$.userId",
          "outputUrl.$": "$.statusResult.payload.outputFile",
          "renderId.$": "$.renderResult.payload.renderId",
          "bucketName.$": "$.renderResult.payload.bucketName"
        }
      },
      "End": true
    },
    "RenderFailed": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke",
      "Parameters": {
        "FunctionName": "$LAMBDA_ARN",
        "Payload": {
          "action": "failed",
          "exportId.$": "$.exportId",
          "projectId.$": "$.projectId",
          "userId.$": "$.userId",
          "error.$": "$.statusResult.payload.error"
        }
      },
      "End": true
    }
  }
}
EOF

STATE_MACHINE_ARN=$(aws stepfunctions create-state-machine \
  --name "$STATE_MACHINE_NAME" \
  --definition file://infrastructure/state-machine.json \
  --role-arn "$STATE_MACHINE_ROLE_ARN" \
  --region "$REGION" \
  --query 'stateMachineArn' --output text 2>/dev/null || \
  aws stepfunctions list-state-machines --region "$REGION" \
    --query "stateMachines[?name=='$STATE_MACHINE_NAME'].stateMachineArn" --output text)

if [ -n "$STATE_MACHINE_ARN" ]; then
  aws stepfunctions update-state-machine \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --definition file://infrastructure/state-machine.json \
    --region "$REGION" > /dev/null 2>&1 || true
fi

echo "   State Machine: $STATE_MACHINE_ARN"

# === FIXED: Update Lambda with STATE_MACHINE_ARN inside Variables{} ===
echo "Updating Lambda with State Machine ARN..."

ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=\"${REMOTION_FUNCTION_NAME}\",REMOTION_SERVE_URL=\"${REMOTION_SERVE_URL}\",QUEUE_URL=\"${QUEUE_URL}\",AWS_REGION_OVERRIDE=\"${REGION}\",STATE_MACHINE_ARN=\"${STATE_MACHINE_ARN}\""
[ -n "$WEBHOOK_SECRET" ] && ENV_VARS="${ENV_VARS},WEBHOOK_SECRET=\"${WEBHOOK_SECRET}\""
[ -n "$WEBHOOK_URL" ] && ENV_VARS="${ENV_VARS},WEBHOOK_URL=\"${WEBHOOK_URL}\""
ENV_VARS="${ENV_VARS}}"

sleep 15
aws lambda update-function-configuration \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --environment "$ENV_VARS" \
  --region "$REGION" > /dev/null

echo "   Lambda config updated with State Machine ARN"

# 14. Connect SQS to Lambda
echo "14. Connecting SQS trigger..."
if ! aws lambda list-event-source-mappings \
  --function-name "$LAMBDA_FUNCTION_NAME" --region "$REGION" \
  --query "EventSourceMappings[?EventSourceArn=='$QUEUE_ARN'].UUID" --output text | grep -q .; then
  
  aws lambda create-event-source-mapping \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --event-source-arn "$QUEUE_ARN" \
    --batch-size 1 \
    --maximum-batching-window-in-seconds 0 \
    --function-response-types ReportBatchItemFailures \
    --region "$REGION" > /dev/null
  echo "   SQS trigger created"
fi

# 15. Update .env
echo "15. Updating .env..."
cd ../../ 2>/dev/null || cd ../
[ ! -f .env ] && touch .env

update_env() {
  local key="$1"
  local value="$2"
  if grep -q "^$key=" .env 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^$key=.*|$key=$value|" .env
    else
      sed -i "s|^$key=.*|$key=$value|" .env
    fi
  else
    echo "$key=$value" >> .env
  fi
}

update_env REMOTION_SQS_QUEUE_URL "$QUEUE_URL"
update_env REMOTION_LAMBDA_FUNCTION_NAME "$REMOTION_FUNCTION_NAME"
update_env REMOTION_SERVE_URL "$REMOTION_SERVE_URL"
update_env REMOTION_WORKER_FUNCTION_NAME "$LAMBDA_FUNCTION_NAME"
update_env STATE_MACHINE_ARN "$STATE_MACHINE_ARN"
update_env BUCKET_NAME "$BUCKET_NAME"
update_env LAMBDA_FUNCTION_NAME "$LAMBDA_FUNCTION_NAME"
update_env AWS_REGION "$REGION"
update_env DLQ_URL "$DLQ_URL"

if ! grep -q "^WEBHOOK_SECRET=" .env 2>/dev/null; then
  echo "WEBHOOK_SECRET=$(openssl rand -hex 32)" >> .env
fi

rm -f lambda/render-function/function.zip 2>/dev/null || true

echo ""
echo "=========================================="
echo "SETUP COMPLETE!"
echo "=========================================="
echo "Queue URL:          $QUEUE_URL"
echo "DLQ URL:            $DLQ_URL"
echo "Worker Lambda:      $LAMBDA_FUNCTION_NAME"
echo "Render Function:    $REMOTION_FUNCTION_NAME"
echo "Site URL:           $REMOTION_SERVE_URL"
echo "State Machine:      $STATE_MACHINE_ARN"
echo "Bucket:             $BUCKET_NAME"
echo "Region:             $REGION"
echo ""
echo "Next Steps:"
echo "1. Check your .env file for all variables"
echo "2. Test: npm run test-render"
echo "3. Update code: ./setup.sh --update-only"
echo "4. Monitor: aws stepfunctions list-executions --state-machine-arn $STATE_MACHINE_ARN --region $REGION"
echo ""