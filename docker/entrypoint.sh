#!/bin/sh
# Gateway does NOT run migrations.
# All DB migrations are owned by herald-admin-registration-api.
# Migrations run there on startup before this service is healthy.
echo "[entrypoint] Starting gateway server..."
exec node dist/main.js
