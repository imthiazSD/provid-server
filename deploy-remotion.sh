#!/bin/bash

# Remotion Lambda Deployment Script
# This script deploys your Remotion Lambda function and site

set -e  # Exit on error

echo "🚀 Starting Remotion Lambda Deployment..."

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &> /dev/null; then
    echo "❌ AWS credentials not configured. Please run 'aws configure'"
    exit 1
fi

# Check if Remotion CLI is installed
if ! command -v remotion &> /dev/null; then
    echo "📦 Installing Remotion CLI..."
    npm install -g @remotion/cli
fi

# Step 1: Deploy Lambda Function
echo ""
echo "📤 Deploying Lambda function..."
FUNCTION_OUTPUT=$(npx remotion lambda functions deploy --region us-east-1)
FUNCTION_NAME=$(echo "$FUNCTION_OUTPUT" | grep -oP 'Function name: \K.*')

if [ -z "$FUNCTION_NAME" ]; then
    echo "❌ Failed to extract function name"
    exit 1
fi

echo "✅ Lambda function deployed: $FUNCTION_NAME"

# Step 2: Build and Deploy Site
echo ""
echo "🏗️  Building Remotion bundle..."
npx remotion bundle src/remotion/index.tsx --bundle-cache ./bundle-cache

echo ""
echo "📤 Deploying site to S3..."
SITE_OUTPUT=$(npx remotion lambda sites create --region us-east-1)
SITE_URL=$(echo "$SITE_OUTPUT" | grep -oP 'Serve URL: \K.*')

if [ -z "$SITE_URL" ]; then
    echo "❌ Failed to extract site URL"
    exit 1
fi

echo "✅ Site deployed: $SITE_URL"

# Step 3: Update .env file
echo ""
echo "📝 Updating .env file..."

# Check if .env exists, if not create from .env.example
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "Created .env from .env.example"
    else
        touch .env
        echo "Created new .env file"
    fi
fi

# Update or add environment variables
sed -i.bak "s|REMOTION_LAMBDA_FUNCTION_NAME=.*|REMOTION_LAMBDA_FUNCTION_NAME=$FUNCTION_NAME|" .env
sed -i.bak "s|REMOTION_SERVE_URL=.*|REMOTION_SERVE_URL=$SITE_URL|" .env

# If the variables don't exist, append them
if ! grep -q "REMOTION_LAMBDA_FUNCTION_NAME" .env; then
    echo "REMOTION_LAMBDA_FUNCTION_NAME=$FUNCTION_NAME" >> .env
fi
if ! grep -q "REMOTION_SERVE_URL" .env; then
    echo "REMOTION_SERVE_URL=$SITE_URL" >> .env
fi

rm -f .env.bak

# Step 4: Test the setup
echo ""
echo "🧪 Testing Lambda function..."
aws lambda get-function --function-name "$FUNCTION_NAME" --region us-east-1 > /dev/null
echo "✅ Lambda function is accessible"

# Step 5: Display summary
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "✅ Deployment Complete!"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📋 Configuration:"
echo "   Function Name: $FUNCTION_NAME"
echo "   Site URL: $SITE_URL"
echo "   Region: us-east-1"
echo ""
echo "📝 Next Steps:"
echo "   1. Check your .env file has been updated"
echo "   2. Restart your API server to load new configuration"
echo "   3. Test an export: POST /api/exports/projects/:projectId/export"
echo "   4. Monitor CloudWatch logs for any issues"
echo ""
echo "💡 Useful Commands:"
echo "   - View Lambda logs: aws logs tail /aws/lambda/$FUNCTION_NAME --follow"
echo "   - List sites: npx remotion lambda sites ls"
echo "   - Delete function: npx remotion lambda functions rm $FUNCTION_NAME"
echo ""
echo "════════════════════════════════════════════════════════════════"