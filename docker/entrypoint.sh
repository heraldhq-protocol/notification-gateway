#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma migrate deploy
echo "[entrypoint] Migrations complete. Starting server..."

exec node dist/main.js
