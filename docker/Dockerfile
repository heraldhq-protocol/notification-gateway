# ─────────────────────────────────────────────────────────────────────
# Herald Notification Gateway — Production Dockerfile
# ─────────────────────────────────────────────────────────────────────
# Multi-stage build for minimal production image.
# Final image: Node.js 20 LTS Alpine (~130MB)
# ─────────────────────────────────────────────────────────────────────

# ── Stage 1: Install Dependencies ────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
RUN corepack enable pnpm

COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/
RUN pnpm install --frozen-lockfile --prod=false

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY . .
RUN pnpx prisma generate
RUN pnpm run build

# ── Stage 3: Production Image ────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
RUN corepack enable pnpm

# Runtime system deps + non-root user
RUN apk add --no-cache \
    wget \
    ca-certificates \
    tzdata \
    && rm -rf /var/cache/apk/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nodejs

# Copy only what's needed for production
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./

# MJML templates
COPY --from=builder /app/src/modules/template/templates ./dist/modules/template/templates

RUN chown -R nodejs:nodejs /app
USER nodejs

# HEALTHCHECK is defined in the ECS task definition, not here.
EXPOSE 3000
CMD ["node", "dist/main.js"]
