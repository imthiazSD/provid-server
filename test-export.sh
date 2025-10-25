#!/bin/bash

# Test Export Script
# This script helps you test the export functionality

API_URL="${API_URL:-http://localhost:5000}"
AUTH_TOKEN="${AUTH_TOKEN}"

if [ -z "$AUTH_TOKEN" ]; then
    echo "❌ Please set AUTH_TOKEN environment variable"
    echo "   Example: export AUTH_TOKEN='your_jwt_token'"
    exit 1
fi

PROJECT_ID="${1}"

if [ -z "$PROJECT_ID" ]; then
    echo "❌ Please provide PROJECT_ID as argument"
    echo "   Usage: ./test-export.sh <project_id>"
    exit 1
fi

echo "🧪 Testing Export Flow..."
echo "API: $API_URL"
echo "Project ID: $PROJECT_ID"
echo ""

# Step 1: Start Export
echo "1️⃣  Starting export..."
EXPORT_RESPONSE=$(curl -s -X POST "$API_URL/api/exports/projects/$PROJECT_ID/export" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "compositionId": "MainComposition",
    "codec": "h264"
  }')

echo "$EXPORT_RESPONSE" | jq '.'

EXPORT_ID=$(echo "$EXPORT_RESPONSE" | jq -r '.data.exportId')
RENDER_ID=$(echo "$EXPORT_RESPONSE" | jq -r '.data.renderId')

if [ "$EXPORT_ID" = "null" ] || [ -z "$EXPORT_ID" ]; then
    echo "❌ Failed to start export"
    exit 1
fi

echo "✅ Export started"
echo "   Export ID: $EXPORT_ID"
echo "   Render ID: $RENDER_ID"
echo ""

# Step 2: Poll Status
echo "2️⃣  Polling export status..."
MAX_ATTEMPTS=60
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    ATTEMPT=$((ATTEMPT + 1))
    
    STATUS_RESPONSE=$(curl -s "$API_URL/api/exports/$EXPORT_ID/status" \
      -H "Authorization: Bearer $AUTH_TOKEN")
    
    STATUS=$(echo "$STATUS_RESPONSE" | jq -r '.data.status')
    PROGRESS=$(echo "$STATUS_RESPONSE" | jq -r '.data.progress.overallProgress // 0')
    
    echo "   [$ATTEMPT/$MAX_ATTEMPTS] Status: $STATUS | Progress: $(echo "$PROGRESS * 100" | bc -l | xargs printf "%.1f")%"
    
    if [ "$STATUS" = "completed" ]; then
        echo ""
        echo "✅ Export completed!"
        OUTPUT_URL=$(echo "$STATUS_RESPONSE" | jq -r '.data.outputUrl')
        echo "   Output URL: $OUTPUT_URL"
        echo ""
        echo "📺 You can download the video from:"
        echo "   $OUTPUT_URL"
        exit 0
    elif [ "$STATUS" = "failed" ]; then
        echo ""
        echo "❌ Export failed!"
        ERROR=$(echo "$STATUS_RESPONSE" | jq -r '.data.errorMessage')
        echo "   Error: $ERROR"
        exit 1
    fi
    
    sleep 5
done

echo ""
echo "⏱️  Timeout reached. Export is still processing."
echo "   Check status manually: GET $API_URL/api/exports/$EXPORT_ID/status"