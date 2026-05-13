#!/bin/sh
# Gateway does NOT run migrations.
# All DB migrations are owned by herald-admin-registration-api.
# Migrations run there on startup before this service is healthy.
set -e

MODE="${1:-$SERVICE_TYPE}"

if [ "$MODE" = "worker" ]; then
  echo "[entrypoint] Starting worker process..."
  exec node dist/worker-main.js
elif [ "$MODE" = "dev" ]; then
  echo "[entrypoint] Starting dev gateway with hot-reload..."
  exec pnpm run start:dev
else
  echo "[entrypoint] Starting gateway server..."
  exec node dist/main.js
fi
