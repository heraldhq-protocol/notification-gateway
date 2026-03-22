# Herald Notification Gateway

> **Privacy-preserving notification delivery for Solana protocols.**
>
> Protocols send notifications via REST API → Herald resolves the recipient's on-chain identity → decrypts the email inside a TEE → delivers via email → writes a ZK delivery receipt on Solana.

```
                         ┌─────────────────────────────────────────────────────────┐
                         │                   Herald Gateway                       │
  Protocol (SDK)         │                                                         │
  ───────────────►       │  API ─► Auth ─► Notify ─► Queue ─► Worker ─► Mail ─►   │
  POST /v1/notify        │                   │                  │                  │
                         │                   ▼                  ▼                  │
                         │              Routing             Receipt               │
                         │           (Solana PDA             (Light               │
                         │            + Redis)              Protocol)             │
                         └─────────────────────────────────────────────────────────┘
```

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/herald-protocol/herald-notification-gateway.git
cd herald-notification-gateway
pnpm install

# 2. Start infrastructure (Postgres, Redis, Mailhog)
docker compose -f docker/docker-compose.dev.yml up -d

# 3. Generate Prisma client and run migrations
npx prisma generate
npx prisma migrate dev

# 4. Start the development server
pnpm run start:dev

# 5. Open Swagger docs
open http://localhost:3000/docs
```

## Tech Stack

| Layer          | Technology                                    |
|:---------------|:----------------------------------------------|
| Runtime        | Node.js 20 LTS                                |
| Framework      | NestJS 11                                      |
| Language       | TypeScript 5.4                                 |
| Database       | PostgreSQL 16 (Prisma 7 ORM)                   |
| Cache / Queue  | Redis 7 (ioredis) + BullMQ                     |
| Blockchain     | Solana (`@solana/web3.js`, `@herald-protocol/sdk`) |
| Email          | Nodemailer / Resend / AWS SES                  |
| Templating     | MJML + Handlebars + Juice (CSS inlining)       |
| Validation     | Zod (config) + class-validator (DTOs)          |
| API Docs       | Swagger / OpenAPI 3.0                          |
| Hosting        | AWS ECS Fargate (multi-AZ), us-east-1          |

## Project Structure

```
src/
├── main.ts                         # Bootstrap: Helmet, CORS, Swagger, pipes, filters
├── app.module.ts                   # Root module — wires all feature modules
│
├── config/
│   ├── configuration.schema.ts     # Zod schema — 40+ validated env vars
│   ├── configuration.ts            # Factory function (Zod → NestJS ConfigModule)
│   └── index.ts                    # Barrel export
│
├── database/
│   ├── prisma.service.ts           # PrismaClient lifecycle management
│   └── prisma.module.ts            # Global Prisma provider
│
├── solana/
│   ├── rpc-manager.service.ts      # Helius primary / QuickNode fallback + circuit breaker
│   ├── solana.service.ts           # Herald SDK ReadClient for PDA lookups
│   └── solana.module.ts
│
├── common/
│   ├── types/                      # AuthenticatedProtocol, IdentityAccount, JobData
│   ├── decorators/                 # @ApiKey(), @CorrelationId()
│   ├── dto/                        # PaginationDto, ApiErrorResponseDto
│   ├── exceptions/                 # HeraldException hierarchy + global ExceptionFilter
│   ├── guards/                     # AuthGuard (API key), ScopeGuard (permissions)
│   ├── interceptors/               # LoggingInterceptor (PII-redacted), Timeout, ResponseTime
│   └── pipes/                      # SolanaPubkeyPipe, UlidPipe
│
└── modules/
    ├── auth/                       # AuthService (key hashing, Redis cache, PG lookup)
    │   ├── auth.service.ts         #   + RateLimitService (sliding window via ZADD)
    │   └── rate-limit.service.ts
    │
    ├── health/                     # GET /health — DB, Redis, Solana status
    │
    ├── notify/                     # Core business logic
    │   ├── dto/notify.dto.ts       #   Swagger-documented request/response DTOs
    │   ├── notify.controller.ts    #   POST /v1/notify, /v1/notify/batch, GET /v1/notifications
    │   └── notify.service.ts       #   Idempotency → PDA lookup → opt-in check → DB → queue
    │
    ├── routing/                    # Wallet → email resolution
    │   ├── routing.service.ts      #   Redis-cached PDA lookup + TEE delegation
    │   └── enclave.service.ts      #   Nitro Enclave socket (prod) / mock (dev)
    │
    ├── queue/                      # Async processing
    │   ├── queue.constants.ts      #   5 named queues (notification, receipt-batch, webhook, bounce, digest)
    │   ├── queue.service.ts        #   Enqueue with 3-retry exponential backoff
    │   └── workers/
    │       └── mail.worker.ts      #   PDA → TEE decrypt → template render → SMTP send → status update
    │
    ├── mail/                       # Environment-aware email dispatch
    │   ├── mail.service.ts         #   Auto-fallback: SES → SMTP
    │   └── providers/
    │       ├── provider.interface.ts
    │       ├── smtp.provider.ts    #   Development (Mailhog)
    │       ├── resend.provider.ts  #   Staging (Resend API)
    │       └── ses.provider.ts     #   Production (AWS SES raw email)
    │
    ├── template/                   # Email rendering pipeline
    │   ├── template.service.ts     #   Handlebars → MJML → Juice (CSS inlining)
    │   └── templates/defi-alert/   #   MJML template + plain text fallback
    │
    ├── webhook/                    # Webhook CRUD + dispatch
    ├── bounce/                     # SES SNS bounce/complaint handler
    ├── analytics/                  # Delivery stats + usage/quota
    ├── protocol/                   # Protocol self-service (GET /v1/protocols/me)
    └── billing/                    # Helio & Solana billing integration
        ├── helio/                  #   Checkout generation and Webhook verification
        ├── subscription/           #   Lifecycle management, Schedulers, and Guards
        ├── onchain/                #   Sync off-chain state to herald_privacy_registry
        └── repositories/           #   Prisma wrappers for billing models
```

## API Endpoints

All endpoints (except `/health`) require `Authorization: Bearer hrld_live_xxx`.

| Method | Path                      | Description                              |
|:-------|:--------------------------|:-----------------------------------------|
| GET    | `/health`                 | Service health status (no auth)          |
| POST   | `/v1/notify`              | Send notification to a wallet (202)      |
| POST   | `/v1/notify/batch`        | Batch send up to 100 (202)               |
| GET    | `/v1/notifications/:id`   | Get notification status                  |
| GET    | `/v1/notifications`       | List notifications (paginated)           |
| POST   | `/v1/webhooks`            | Register webhook endpoint                |
| GET    | `/v1/webhooks`            | List registered webhooks                 |
| PATCH  | `/v1/webhooks/:id`        | Update webhook                           |
| DELETE | `/v1/webhooks/:id`        | Remove webhook                           |
| GET    | `/v1/analytics`           | Delivery analytics (7d/30d/90d)          |
| GET    | `/v1/usage`               | Current usage vs. quota                  |
| GET    | `/v1/protocols/me`        | Protocol self-service info               |
| GET    | `/v1/billing/status`      | Check subscription limits and tier       |
| GET    | `/v1/billing/checkout`    | Generate Helio checkout URL              |
| POST   | `/v1/billing/helio/webhook` | Helio payment webhooks (no auth)       |

Full interactive documentation is available at **http://localhost:3000/docs** (Swagger UI).

## Notification Flow

```
Protocol calls POST /v1/notify
         │
         ▼
┌─── AuthGuard ───┐     ┌── RateLimit ──┐
│ Bearer hrld_xxx │ ──► │ ZADD sliding  │
│ SHA-256 → Redis │     │ window check  │
│ → PostgreSQL    │     └───────────────┘
└─────────────────┘           │
                              ▼
                    ┌── NotifyService ──────────────┐
                    │ 1. Idempotency check (UUID)   │
                    │ 2. PDA lookup (Redis cache)   │
                    │ 3. Opt-in flag check          │
                    │ 4. INSERT notification (PG)   │
                    │ 5. Enqueue BullMQ job          │
                    │ 6. Return 202 + ULID           │
                    └───────────────────────────────┘
                              │
                              ▼ (async worker)
                    ┌── MailWorker ──────────────────┐
                    │ 1. Resolve identity (Solana)   │
                    │ 2. Decrypt email via TEE       │
                    │    (Nitro Enclave socket)       │
                    │ 3. Render template              │
                    │    (Handlebars → MJML → Juice) │
                    │ 4. Send email (SES/Resend/SMTP)│
                    │ 5. UPDATE notification status   │
                    │ 6. Email var goes out of scope  │
                    │    (SEC-001: GC collects)       │
                    └────────────────────────────────┘
```

## Security Model

### Zero-PII Design

| Data              | Storage    | Notes                                      |
|:------------------|:-----------|:-------------------------------------------|
| Wallet addresses  | SHA-256    | Only hashes stored in PostgreSQL            |
| API keys          | SHA-256    | Plaintext shown once at creation            |
| Email addresses   | Never      | Encrypted on-chain, decrypted only in TEE   |
| Webhook secrets   | SHA-256    | Plaintext shown once at creation            |
| Subjects          | SHA-256    | Not stored in plaintext in the database     |

### API Key Format

```
hrld_live_4xR9mKp2nQwBvTsYjL8dHcFoEa3ZiXuW   (production)
hrld_test_7yN1pKq4mSwBvRsXjM9eJcGoFb2AiYuV   (sandbox)
```

### Rate Limits

| Tier        | Requests/sec | Burst | Monthly     |
|:------------|:-------------|:------|:------------|
| Developer   | 2            | 10    | 1,000       |
| Growth      | 20           | 100   | 50,000      |
| Scale       | 100          | 500   | 250,000     |
| Enterprise  | 500          | 2,000 | 1,000,000   |

## Environment Variables

Configuration is validated at startup using Zod (see `src/config/configuration.schema.ts`).

```env
# Required
DATABASE_URL=postgresql://herald:herald_dev@localhost:5432/herald_gateway

# Solana
SOLANA_RPC_URL=http://localhost:8899
HERALD_PROGRAM_ID=2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf
DEV_AUTHORITY_KEYPAIR_PATH=scripts/test-authority-keypair.json

# Helio Billing
HELIO_API_KEY=sk_live_...
HELIO_WEBHOOK_SECRET=wh_sec_...
HELIO_TEMPLATE_GROWTH=tmp_req_...
HELIO_TEMPLATE_SCALE=tmp_req_...
HELIO_TEMPLATE_ENTERPRISE=tmp_req_...

# Mail provider (smtp | resend | ses)
MAIL_PROVIDER=smtp

# See .env for full list with defaults
```

## Docker

```bash
# Development stack (Postgres + Redis + Mailhog)
docker compose -f docker/docker-compose.dev.yml up -d

# Production build
docker build -f docker/Dockerfile -t herald-gateway .
docker run -p 3000:3000 --env-file .env herald-gateway
```

### Development Services

| Service          | Port  | URL                         |
|:-----------------|:------|:----------------------------|
| Gateway API      | 3000  | http://localhost:3000       |
| Swagger Docs     | 3000  | http://localhost:3000/docs  |
| PostgreSQL       | 5432  | localhost:5432              |
| Redis            | 6379  | localhost:6379              |
| Mailhog SMTP     | 1025  | localhost:1025              |
| Mailhog Web UI   | 8025  | http://localhost:8025       |
| Redis Commander  | 8081  | http://localhost:8081       |

## Database Schema

11 tables following zero-PII design:

- **protocols** — registered protocol accounts (tier, sends, subscription)
- **api_keys** — SHA-256 hashed keys with scopes and environments
- **notifications** — delivery lifecycle tracking (status, receipt_tx, bounce)
- **webhooks** — registered webhook endpoints per protocol
- **webhook_deliveries** — delivery attempt log
- **dkim_keys** — DKIM key management with DNS verification status
- **email_bounces** — bounce/complaint tracking (hard/soft/complaint)
- **digest_queue** — batched notification scheduling
- **subscriptions** — Active billing subscriptions mapped to protocols
- **payments** — Historically successful payments from USDC/USDT directly or via Helio
- **helio_webhook_events** — Processed events payload hashes for strong idempotency

```bash
# View schema
npx prisma studio

# Create migration
npx prisma migrate dev --name <description>
```

## Scripts

```bash
pnpm run start:dev    # Development with hot reload
pnpm run build        # TypeScript compilation
pnpm run start:prod   # Production start
pnpm run test         # Unit tests
pnpm run test:e2e     # End-to-end tests
pnpm run lint         # ESLint
```

## License

UNLICENSED — proprietary software.
