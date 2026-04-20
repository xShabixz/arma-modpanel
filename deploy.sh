#!/usr/bin/env bash
# Deploy script for this project.
# Run this on your local machine (Git Bash, WSL, Linux, macOS).
#
# Required environment variables:
#   DEPLOY_REMOTE=user@server
#   DEPLOY_DIR=/absolute/path/on/remote
#
# Optional environment variables:
#   DEPLOY_HEALTH_URL=http://127.0.0.1:3000/health
#
# Example:
#   DEPLOY_REMOTE=user@example.com DEPLOY_DIR=/home/user/ptero-mod-manager bash deploy.sh
set -e

REMOTE="${DEPLOY_REMOTE:-}"
DIR="${DEPLOY_DIR:-}"
HEALTH_URL="${DEPLOY_HEALTH_URL:-http://127.0.0.1:3000/health}"

if [ -z "$REMOTE" ] || [ -z "$DIR" ]; then
	echo "ERROR: DEPLOY_REMOTE and DEPLOY_DIR are required."
	echo "Example: DEPLOY_REMOTE=user@server DEPLOY_DIR=/home/user/ptero-mod-manager bash deploy.sh"
	exit 1
fi

echo "=== [1/5] Creating directories ==="
ssh "$REMOTE" "mkdir -p $DIR/src/views $DIR/dist/views"

echo "=== [2/5] Uploading files ==="
scp -r src "$REMOTE:$DIR/"
scp package.json "$REMOTE:$DIR/package.json"
scp tsconfig.json "$REMOTE:$DIR/tsconfig.json"
scp .env.example "$REMOTE:$DIR/.env.example"

echo "=== [3/5] Building TypeScript ==="
ssh "$REMOTE" "cd $DIR && npm run build"

echo "=== [4/5] Copying view assets to dist ==="
ssh "$REMOTE" "mkdir -p $DIR/dist/views && cp $DIR/src/views/* $DIR/dist/views/"

echo "=== [5/5] Restarting service ==="
ssh "$REMOTE" "cd $DIR && pkill -f 'node dist/index.js' 2>/dev/null || true; nohup node dist/index.js >/tmp/ptero-mod-manager.log 2>&1 & sleep 2; curl -sS $HEALTH_URL"

echo ""
echo "Deploy complete"
echo "Health endpoint: $HEALTH_URL"
