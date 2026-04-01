#!/usr/bin/env bash
set -euo pipefail

echo "Building TypeScript..."
npm run build

echo "Deploying to Railway..."
railway up

echo "Done!"
