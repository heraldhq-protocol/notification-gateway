#!/bin/sh
# Runs prisma migrate deploy before starting the app.
# Handles the case where the DB was previously managed via db:push (no
# migration history recorded), by baselining all migrations as applied
# and retrying if the first attempt fails with "already exists".

echo "[entrypoint] Running database migrations..."

if ! NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma migrate deploy > /tmp/migrate.log 2>&1; then
  cat /tmp/migrate.log

  if grep -qE "already exist|P3009|P3005|P3018" /tmp/migrate.log; then
    echo "[entrypoint] Schema exists but has no migration history (db:push). Baselining..."
    for dir in prisma/migrations/*/; do
      NAME=$(basename "$dir")
      [ "$NAME" = "*" ] && continue
      NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma migrate resolve --applied "$NAME" 2>/dev/null || true
      echo "[entrypoint]   marked applied: $NAME"
    done
    echo "[entrypoint] Baselining done. Re-running migrate deploy..."
    NODE_TLS_REJECT_UNAUTHORIZED=0 npx prisma migrate deploy
  else
    echo "[entrypoint] Migration failed — aborting startup."
    exit 1
  fi
else
  cat /tmp/migrate.log
fi

echo "[entrypoint] Migrations complete. Starting server..."
exec node dist/main.js
