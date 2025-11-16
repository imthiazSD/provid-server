#!/bin/bash
set -e

# === CONFIG ===
REGION="us-east-1"
BUCKET="remotion-lambda-code-prod"
LAMBDA_NAME="remotion-render-worker"
LAYER_NAME="remotion-worker-layer"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "Starting deployment in $REGION..."

# === 1. Create S3 bucket ===
aws s3 mb "s3://$BUCKET" --region "$REGION" 2>/dev/null || true

# === 2. Build function & layer ===
cd lambda/render-function
npm ci --production
npm run build
rm -f function.zip layer.zip

echo "Building function.zip..."
(cd dist && zip -r ../function.zip .) > /dev/null
zip -r function.zip package.json > /dev/null

echo "Building layer.zip..."
mkdir -p layer/nodejs
# Copy entire node_modules directory
cp -r node_modules layer/nodejs/
(cd layer && zip -r ../layer.zip nodejs) > /dev/null
cd ../../

# === 3. Upload to S3 ===
echo "Uploading to S3..."
aws s3 cp lambda/render-function/function.zip "s3://$BUCKET/function.zip" --region "$REGION"
aws s3 cp lambda/render-function/layer.zip "s3://$BUCKET/layer.zip" --region "$REGION"

# === 4. Clean up old Remotion functions and deploy new ===
echo "Installing Remotion project dependencies..."
cd src/remotion
npm install 2>/dev/null || echo "No package.json in src/remotion, using root dependencies"
cd ../..

echo "Cleaning up old Remotion functions..."
OLD_FUNCTIONS=$(aws lambda list-functions --region "$REGION" --query 'Functions[?starts_with(FunctionName, `remotion-render-`)].FunctionName' --output text)
for func in $OLD_FUNCTIONS; do
  echo "Deleting: $func"
  aws lambda delete-function --function-name "$func" --region "$REGION" 2>/dev/null || true
done

echo "Cleaning up old Remotion sites..."
SITES=$(./node_modules/.bin/remotion lambda sites ls --region "$REGION" --quiet 2>/dev/null || echo "")
if [ ! -z "$SITES" ]; then
  echo "$SITES" | while read -r site; do
    if [ ! -z "$site" ]; then
      echo "Removing site: $site"
      ./node_modules/.bin/remotion lambda sites rm "$site" --region "$REGION" --yes 2>/dev/null || true
    fi
  done
fi

echo "Deploying new Remotion render function..."
REMOTION_FUNCTION_NAME=$(./node_modules/.bin/remotion lambda functions deploy --region "$REGION" --yes | grep -oE "remotion-render-[a-z0-9-]+" | head -1)
[ -z "$REMOTION_FUNCTION_NAME" ] && { echo "ERROR: Failed to deploy Remotion function"; exit 1; }
echo "Remotion function deployed: $REMOTION_FUNCTION_NAME"

echo "Deploying Remotion site..."
REMOTION_SERVE_URL=$(./node_modules/.bin/remotion lambda sites create src/remotion/index.tsx --region "$REGION" | grep -o 'https://[^ ]\+' | head -1)
[ -z "$REMOTION_SERVE_URL" ] && { echo "ERROR: Failed to deploy site"; exit 1; }
echo "Remotion site deployed: $REMOTION_SERVE_URL"

# === 5. Publish Layer ===
echo "Publishing Lambda layer..."
LAYER_VERSION=$(aws lambda publish-layer-version \
  --layer-name "$LAYER_NAME" \
  --content S3Bucket="$BUCKET",S3Key=layer.zip \
  --compatible-runtimes nodejs20.x \
  --region "$REGION" \
  --query 'Version' --output text)

LAYER_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:layer:$LAYER_NAME:$LAYER_VERSION"
echo "Layer published: $LAYER_ARN"

# === 6. Create Worker Lambda Role (lambda-exec-role) ===
ROLE_NAME="lambda-exec-role"
if ! aws iam get-role --role-name "$ROLE_NAME" > /dev/null 2>&1; then
  echo "Creating IAM role: $ROLE_NAME"
  aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
    }' > /dev/null

  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess
else
  echo "Using existing role: $ROLE_NAME"
fi

# === 6.5 Add CloudWatch Logs Permissions ===
echo "Granting CloudWatch Logs access to $ROLE_NAME..."
cat > /tmp/logs-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],
      "Resource": "arn:aws:logs:*:*:*"
    }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name AllowCloudWatchLogs --policy-document file:///tmp/logs-policy.json

# === 6.6 Add Step Functions Permissions ===
cat > /tmp/sfn-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Action": "states:*", "Resource": "*"}]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name AllowStepFunctions --policy-document file:///tmp/sfn-policy.json

# === 6.7 Add Lambda Invoke Permissions ===
echo "Granting Lambda invoke permissions to $ROLE_NAME..."
cat > /tmp/lambda-invoke-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "lambda:InvokeFunction",
        "lambda:InvokeAsync"
      ],
      "Resource": "arn:aws:lambda:$REGION:$ACCOUNT_ID:function:remotion-render-*"
    }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name AllowLambdaInvoke --policy-document file:///tmp/lambda-invoke-policy.json

ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"

# === 7. Create Step Functions Role (stepfunctions-role) ===
SFN_ROLE_NAME="stepfunctions-role"
if ! aws iam get-role --role-name "$SFN_ROLE_NAME" > /dev/null 2>&1; then
  echo "Creating Step Functions role: $SFN_ROLE_NAME"
  aws iam create-role \
    --role-name "$SFN_ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow", "Principal": {"Service": "states.amazonaws.com"}, "Action": "sts:AssumeRole"}]
    }' > /dev/null

  aws iam attach-role-policy --role-name "$SFN_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaRole
  aws iam attach-role-policy --role-name "$SFN_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/CloudWatchLogsFullAccess

  cat > /tmp/sfn-lambda-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{"Effect": "Allow", "Action": "lambda:InvokeFunction", "Resource": "*"}]
}
EOF
  aws iam put-role-policy --role-name "$SFN_ROLE_NAME" --policy-name AllowLambdaInvoke --policy-document file:///tmp/sfn-lambda-policy.json
else
  echo "Using existing Step Functions role: $SFN_ROLE_NAME"
fi

SFN_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$SFN_ROLE_NAME"

# === 8. Create / Update Worker Lambda ===
# Temporarily disable webhook secret for debugging
# WEBHOOK_SECRET=$(openssl rand -hex 32)
WEBHOOK_SECRET=""

ENV_VARS="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL,AWS_REGION_OVERRIDE=$REGION}"

if ! aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" > /dev/null 2>&1; then
  echo "Creating Lambda: $LAMBDA_NAME"
  aws lambda create-function \
    --function-name "$LAMBDA_NAME" \
    --runtime nodejs20.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --code S3Bucket="$BUCKET",S3Key=function.zip \
    --timeout 900 \
    --memory-size 1024 \
    --layers "$LAYER_ARN" \
    --environment "$ENV_VARS" \
    --region "$REGION"
  
  echo "Waiting for IAM permissions to propagate (15 seconds)..."
  sleep 15
else
  echo "Updating Lambda: $LAMBDA_NAME"
  aws lambda update-function-code \
    --function-name "$LAMBDA_NAME" \
    --s3-bucket "$BUCKET" \
    --s3-key function.zip \
    --region "$REGION" > /dev/null

  aws lambda update-function-configuration \
    --function-name "$LAMBDA_NAME" \
    --layers "$LAYER_ARN" \
    --environment "$ENV_VARS" \
    --region "$REGION" > /dev/null
  
  echo "Waiting for function update (10 seconds)..."
  sleep 10
fi

LAMBDA_ARN=$(aws lambda get-function --function-name "$LAMBDA_NAME" --region "$REGION" --query 'Configuration.FunctionArn' --output text)

# === 8.5. Create Function URL for Webhook ===
echo "Creating Lambda Function URL for webhook..."
FUNCTION_URL=$(aws lambda create-function-url-config \
  --function-name "$LAMBDA_NAME" \
  --auth-type NONE \
  --region "$REGION" \
  --query 'FunctionUrl' --output text 2>/dev/null || \
  aws lambda get-function-url-config \
  --function-name "$LAMBDA_NAME" \
  --region "$REGION" \
  --query 'FunctionUrl' --output text)

echo "Function URL: $FUNCTION_URL"

# Add public access permission for Function URL
aws lambda add-permission \
  --function-name "$LAMBDA_NAME" \
  --statement-id FunctionURLAllowPublicAccess \
  --action lambda:InvokeFunctionUrl \
  --principal "*" \
  --function-url-auth-type NONE \
  --region "$REGION" 2>/dev/null || echo "Permission already exists"

WEBHOOK_URL="${FUNCTION_URL}webhook"

# === 9. State Machine (waitForTaskToken) ===
mkdir -p infrastructure

cat > infrastructure/state-machine.json <<EOF
{
  "Comment": "Remotion Render – WaitForTaskToken Pattern",
  "StartAt": "StartRender",
  "States": {
    "StartRender": {
      "Type": "Task",
      "Resource": "arn:aws:states:::lambda:invoke.waitForTaskToken",
      "Parameters": {
        "FunctionName": "$LAMBDA_ARN",
        "Payload": {
          "action": "start",
          "exportId.\$": "\$.exportId",
          "projectId.\$": "\$.projectId",
          "userId.\$": "\$.userId",
          "renderConfig.\$": "\$.renderConfig",
          "taskToken.\$": "\$\$.Task.Token"
        }
      },
      "HeartbeatSeconds": 600,
      "TimeoutSeconds": 86400,
      "ResultPath": "\$.result",
      "Retry": [
        {
          "ErrorEquals": ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException"],
          "IntervalSeconds": 2,
          "MaxAttempts": 3,
          "BackoffRate": 2.0
        }
      ],
      "Catch": [
        {
          "ErrorEquals": ["States.TaskFailed"],
          "Next": "RenderFailed",
          "ResultPath": "\$.error"
        },
        {
          "ErrorEquals": ["States.Timeout"],
          "Next": "RenderTimeout",
          "ResultPath": "\$.error"
        }
      ],
      "End": true
    },
    "RenderFailed": {
      "Type": "Fail",
      "Error": "RenderFailed",
      "Cause": "Lambda task failed during render"
    },
    "RenderTimeout": {
      "Type": "Fail",
      "Error": "RenderTimeout",
      "Cause": "Render exceeded 24-hour timeout"
    }
  }
}
EOF

STATE_MACHINE_NAME="remotion-workflow"

if ! aws stepfunctions list-state-machines --region "$REGION" --query "stateMachines[?name=='$STATE_MACHINE_NAME'].stateMachineArn" --output text | grep -q .; then
  echo "Creating State Machine..."
  STATE_MACHINE_ARN=$(aws stepfunctions create-state-machine \
    --name "$STATE_MACHINE_NAME" \
    --definition file://infrastructure/state-machine.json \
    --role-arn "$SFN_ROLE_ARN" \
    --region "$REGION" \
    --query 'stateMachineArn' --output text)
else
  echo "Updating State Machine..."
  STATE_MACHINE_ARN=$(aws stepfunctions list-state-machines \
    --region "$REGION" \
    --query "stateMachines[?name=='$STATE_MACHINE_NAME'].stateMachineArn" \
    --output text)
  aws stepfunctions update-state-machine \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --definition file://infrastructure/state-machine.json \
    --role-arn "$SFN_ROLE_ARN" \
    --region "$REGION" > /dev/null
fi

# === 10. Final Lambda Update (add STATE_MACHINE_ARN) ===
echo "Updating Lambda with State Machine ARN..."

if [ -n "$WEBHOOK_SECRET" ]; then
  ENV_VARS_FINAL="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL,STATE_MACHINE_ARN=$STATE_MACHINE_ARN,WEBHOOK_URL=$WEBHOOK_URL,WEBHOOK_SECRET=$WEBHOOK_SECRET,AWS_REGION_OVERRIDE=$REGION}"
else
  ENV_VARS_FINAL="Variables={REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME,REMOTION_SERVE_URL=$REMOTION_SERVE_URL,STATE_MACHINE_ARN=$STATE_MACHINE_ARN,WEBHOOK_URL=$WEBHOOK_URL,AWS_REGION_OVERRIDE=$REGION}"
fi

aws lambda update-function-configuration \
  --function-name "$LAMBDA_NAME" \
  --environment "$ENV_VARS_FINAL" \
  --region "$REGION" > /dev/null

# === 11. .env file ===
cat > .env <<EOF
REMOTION_LAMBDA_FUNCTION_NAME=$REMOTION_FUNCTION_NAME
REMOTION_SERVE_URL=$REMOTION_SERVE_URL
STATE_MACHINE_ARN=$STATE_MACHINE_ARN
LAMBDA_FUNCTION_NAME=$LAMBDA_NAME
WEBHOOK_URL=$WEBHOOK_URL
AWS_REGION=$REGION
EOF

# === DONE ===
echo ""
echo "================================================"
echo "         DEPLOYMENT COMPLETE"
echo "================================================"
echo ""
echo "Remotion Function : $REMOTION_FUNCTION_NAME"
echo "Remotion Site     : $REMOTION_SERVE_URL"
echo "Worker Lambda     : $LAMBDA_ARN"
echo "State Machine     : $STATE_MACHINE_ARN"
echo "Layer             : $LAYER_ARN"
echo "Webhook URL       : $WEBHOOK_URL"
echo ""
echo "------------------------------------------------"
echo "Next Steps:"
echo "1. Update WEBHOOK_URL in the script if needed"
echo "2. Call StartExecution on: $STATE_MACHINE_ARN"
echo "3. Monitor logs: aws logs tail /aws/lambda/remotion-render-worker --follow"
echo "------------------------------------------------"
echo ""
echo "Configuration saved to .env file"
echo ""