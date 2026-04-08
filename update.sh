#!/bin/bash
cd ~/notification-gateway
git pull origin main
pnpm install
pnpm build
pm2 restart herald-notification-gateway