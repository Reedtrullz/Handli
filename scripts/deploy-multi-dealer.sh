#!/bin/sh
set -eu

# Deploy the multi-dealer Tjek update to VPS
# Run this from your local machine after SSH access is restored

VPS="deploy@198.23.137.16"
SSH_KEY="$HOME/.ssh/id_rsa_racknerd"

echo "=== Pulling latest code ==="
ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$VPS" 'cd /opt/apps/handleplan/source && git pull origin main'

COMMIT_SHA=$(ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$VPS" 'cd /opt/apps/handleplan/source && git rev-parse HEAD')
echo "=== Building image for $COMMIT_SHA ==="
ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$VPS" "cd /opt/apps/handleplan/source && docker build --build-arg APP_COMMIT_SHA=$COMMIT_SHA -t handleplan:$COMMIT_SHA ."

echo "=== Redeploying worker ==="
ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$VPS" "cd /opt/apps/handleplan/operations/current/deploy && HANDLEPLAN_IMAGE=handleplan:$COMMIT_SHA HANDLEPLAN_MIGRATION_IMAGE=handleplan:$COMMIT_SHA APP_COMMIT_SHA=$COMMIT_SHA docker compose -f compose.production.yml --env-file /opt/apps/handleplan/shared/production.env up -d worker --no-deps"

echo "=== Verifying ==="
ssh -i "$SSH_KEY" -o IdentitiesOnly=yes "$VPS" 'docker ps --filter name=handleplan-worker --format "{{.Names}}: {{.Status}}"'

echo ""
echo "Done! Wait 30 seconds for the worker to initialize, then check:"
echo "  docker logs handleplan-worker-1 2>&1 | grep tjek"
