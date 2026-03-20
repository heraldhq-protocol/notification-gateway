# Herald Notification Gateway — Architecture

> Internal engineering reference for the Herald Notification Gateway.
> This document explains **how** the system works at the module level,
> including data flows, security boundaries, and design decisions.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Module Dependency Graph](#2-module-dependency-graph)
3. [Request Lifecycle](#3-request-lifecycle)
4. [Authentication & Authorization](#4-authentication--authorization)
5. [Notification Pipeline](#5-notification-pipeline)
6. [Identity Resolution & Routing](#6-identity-resolution--routing)
7. [Email Delivery](#7-email-delivery)
8. [Template Engine](#8-template-engine)
9. [Queue Architecture](#9-queue-architecture)
10. [Database Design](#10-database-design)
11. [Solana Integration](#11-solana-integration)
12. [Security Architecture](#12-security-architecture)
13. [Configuration & Validation](#13-configuration--validation)
14. [Error Handling](#14-error-handling)

---

## 1. System Overview

The Herald Notification Gateway is a **privacy-preserving notification relay** between Solana protocols and end-user email inboxes. The core invariant is:

> **Protocols never learn recipient email addresses.**
> Emails are encrypted on-chain in the Herald Privacy Registry. The Gateway decrypts them
> inside a TEE (AWS Nitro Enclave), delivers the email, and discards the plaintext.

```
  Solana Protocol                    Herald Gateway                       User's Inbox
  ─────────────                     ────────────────                     ──────────────
    API Key                     ┌─ Auth ─ Rate Limit ─┐
  POST /v1/notify ─────────────►│                      │
    {wallet, subject, body}     │  NotifyService       │
                                │   ├─ Idempotency     │
                                │   ├─ PDA Lookup      │────► Solana RPC (Helius / QN)
                                │   ├─ Opt-in Check    │
                                │   ├─ DB Insert       │────► PostgreSQL
                                │   └─ Queue Job       │────► Redis (BullMQ)
                                └──────────────────────┘
                                          │
                                          ▼ (async)
                                ┌── MailWorker ────────┐
                                │  ├─ PDA Resolve      │────► Solana (cached in Redis)
                                │  ├─ TEE Decrypt      │────► Nitro Enclave (email in memory)
                                │  ├─ Template Render  │     Handlebars → MJML → Juice
                                │  ├─ SMTP Send        │────► SES / Resend / Mailhog
                                │  ├─ Update Status    │────► PostgreSQL
                                │  └─ email = null     │     SEC-001: GC collects
                                └──────────────────────┘
                                                                           ──────────►  📧
```

---

## 2. Module Dependency Graph

```
AppModule
├── ConfigModule.forRoot (global)     ← Zod-validated environment
├── PrismaModule (global)             ← PostgreSQL connection
├── BullModule.forRoot                ← Redis connection for queues
├── Redis provider (global)           ← Shared ioredis client
│
├── AuthModule
│   ├── AuthService                   ← API key validation (hash → Redis → PG)
│   └── RateLimitService              ← Sliding window (ZADD)
│
├── HealthModule
│   └── HealthController              ← GET /health (DB + Redis ping)
│
├── NotifyModule
│   ├── NotifyController              ← REST endpoints
│   ├── NotifyService                 ← Orchestration (sync path)
│   ├── imports: AuthModule           ← Guard dependency
│   ├── imports: RoutingModule        ← PDA lookup
│   └── imports: QueueModule          ← Job dispatch
│
├── QueueModule
│   ├── QueueService                  ← Enqueue operations
│   ├── MailWorker                    ← Async delivery processor
│   ├── imports: RoutingModule        ← PDA + TEE
│   ├── imports: MailModule           ← Email sending
│   └── imports: TemplateModule       ← Email rendering
│
├── RoutingModule
│   ├── RoutingService                ← Cached PDA resolution
│   ├── EnclaveService                ← TEE communication
│   └── imports: SolanaModule         ← RPC access
│
├── SolanaModule
│   ├── SolanaService                 ← Herald SDK ReadClient
│   └── RpcManagerService             ← Circuit breaker (Helius → QN)
│
├── MailModule
│   ├── MailService                   ← Provider selection + fallback
│   ├── SmtpProvider                  ← Nodemailer (dev)
│   ├── ResendProvider                ← Resend API (staging)
│   └── SesProvider                   ← AWS SES (production)
│
├── TemplateModule
│   └── TemplateService               ← Handlebars → MJML → Juice pipeline
│
├── WebhookModule
│   └── WebhookController             ← CRUD + test dispatch
│
├── BounceModule
│   └── BounceController              ← SES SNS webhook handler
│
├── AnalyticsModule
│   └── AnalyticsController           ← Stats + usage/quota
│
└── ProtocolModule
    └── ProtocolController            ← Self-service info
```

---

## 3. Request Lifecycle

Every HTTP request passes through these layers in order:

```
Incoming Request
  │
  ├─ 1. Helmet (security headers)
  ├─ 2. CORS check
  ├─ 3. compression middleware
  ├─ 4. ValidationPipe (class-validator: whitelist, transform)
  ├─ 5. ResponseTimeInterceptor (adds X-Response-Time header)
  ├─ 6. LoggingInterceptor (structured logs with PII redaction)
  ├─ 7. TimeoutInterceptor (30s abort)
  ├─ 8. AuthGuard (per-route: Bearer → hash → Redis → PG)
  ├─ 9. ScopeGuard (per-route: check required scopes)
  ├─ 10. Controller handler
  │
  └─ Response or HeraldExceptionFilter (uniform JSON errors)
```

### Correlation IDs

Every request gets a correlation ID injected by the `LoggingInterceptor`. This ID is:
- Generated as a UUID v4 if not provided in `X-Correlation-ID` header
- Attached to the request object
- Included in all log entries
- Passed into BullMQ job data for end-to-end tracing

---

## 4. Authentication & Authorization

### API Key Validation Flow

```
Bearer hrld_live_4xR9...
          │
          ▼
  ┌── isValidKeyFormat() ──┐
  │  Regex: hrld_(live|test)_[base58]{30-60}
  └────────────────────────┘
          │
          ▼
  ┌── SHA-256 hash ────────┐
  │  createHash('sha256')  │
  │  .update(plaintext)    │
  │  .digest('hex')        │
  └────────────────────────┘
          │
          ▼
  ┌── Redis cache check ──┐  HIT ──► return AuthenticatedProtocol
  │  TTL: 60 seconds      │
  └────────────────────────┘
          │ MISS
          ▼
  ┌── PostgreSQL lookup ───┐               ┌── Suspended? ──► 401 AUTH_ACCOUNT_SUSPENDED
  │  api_keys JOIN         │───────────────┤
  │  protocols             │               └── Active ──► Cache 60s ──► return protocol
  └────────────────────────┘
```

### Scope Guard

Routes can require specific scopes via the `@RequiredScopes()` decorator:

```typescript
@RequiredScopes('notify:write', 'webhook:manage')
@UseGuards(AuthGuard, ScopeGuard)
```

Default scopes for new API keys: `['notify:write']`.

---

## 5. Notification Pipeline

### Synchronous Path (< 200ms target)

The `NotifyService.queueNotification()` method handles the synchronous portion:

| Step | Operation | Target | Notes |
|:-----|:----------|:-------|:------|
| 1 | Idempotency check | PostgreSQL | `findUnique` on `idempotency_key` |
| 2 | PDA lookup | Redis → Solana | 5-min cache, Herald SDK `fetchIdentityAccount()` |
| 3 | Opt-in check | In-memory | Category flags: `optInDefi`, `optInGovernance`, etc. |
| 4 | DB insert | PostgreSQL | Status: `queued`, wallet stored as SHA-256 |
| 5 | Queue dispatch | BullMQ (Redis) | Job: `NotificationJobData` (no PII) |
| 6 | Return 202 | HTTP | `{ notification_id: ULID, status: 'queued' }` |

### Asynchronous Path (MailWorker)

The `MailWorker.process()` method handles delivery:

| Step | Operation | Security |
|:-----|:----------|:---------|
| 1 | Resolve identity | Cached Solana PDA lookup |
| 2 | Decrypt email | TEE (Nitro Enclave socket). Plaintext exists ONLY in local variable |
| 3 | Render template | Handlebars → MJML → Juice. No PII in template vars |
| 4 | Send email | SES / Resend / SMTP. `to` field is the only PII touchpoint |
| 5 | Update status | PostgreSQL: `delivered`, `ses_message_id`, `email_provider` |
| 6 | Scope exit | `email` variable is garbage collected (SEC-001) |

**Retry policy:** 3 attempts, exponential backoff (1s, 4s, 16s).

---

## 6. Identity Resolution & Routing

### RoutingService

```
resolveIdentity(walletPubkey)
         │
         ▼
┌── Redis check ───────────┐
│  Key: pda:identity:{pk}  │
│  TTL: 300s (5 min)       │
│  "NOT_REGISTERED" cached │  ──► return null (60s TTL)
│  for 60s to avoid spam   │
└──────────────────────────┘
         │ MISS
         ▼
┌── SolanaService ─────────┐
│  ReadClient              │
│  .fetchIdentityAccount() │  ──► Herald SDK → Anchor deserialization
└──────────────────────────┘
         │
         ▼
   Cache result in Redis
   (Uint8Array → base64 serialization)
```

### EnclaveService

| Environment | Mechanism |
|:------------|:----------|
| `development` / `test` | Returns mock email: `test-{pubkey8}@herald-dev.xyz` |
| `production` | Unix socket to Nitro Enclave at `/run/enclave.sock` |

The production enclave:
1. Receives encrypted email + nonce + owner pubkey via JSON
2. Fetches KMS decryption key from AWS KMS
3. NaCl box_open decryption
4. Returns plaintext email via socket
5. 5-second timeout with `RoutingUnavailableException` on failure

---

## 7. Email Delivery

### Provider Selection

```typescript
MAIL_PROVIDER env var
         │
         ├── 'smtp'   → SmtpProvider (Nodemailer → Mailhog:1025)
         ├── 'resend'  → ResendProvider (Resend API)
         └── 'ses'     → SesProvider (AWS SES raw email), fallback: SmtpProvider
```

### SES Provider Details

The SES provider builds raw MIME using Nodemailer's `streamTransport`, then sends
via `SendRawEmailCommand`. This allows full control over headers (DKIM, configuration sets).

---

## 8. Template Engine

### Rendering Pipeline

```
Template Name (e.g., 'defi-alert')
         │
         ▼
  Load MJML source from filesystem
  src/modules/template/templates/{name}/index.mjml
         │
         ▼
  Handlebars.compile(mjmlSource)
  Inject variables: { protocolName, subject, body, category, unsubscribeUrl }
         │
         ▼
  mjml2html(processedMjml, { minify: true })
  Converts to responsive HTML email
         │
         ▼
  juice(html)
  Inlines CSS for email client compatibility
         │
         ▼
  { html, text, subject }
```

### Custom Handlebars Helpers

- `{{truncate str len}}` — truncate with ellipsis
- `{{formatDate timestamp}}` — unix timestamp to ISO string
- `{{categoryColor category}}` — maps category to hex color
- `{{repeat str count}}` — repeat a string

---

## 9. Queue Architecture

### Named Queues

| Queue | Purpose | Workers |
|:------|:--------|:--------|
| `notification` | Email delivery jobs | `MailWorker` |
| `receipt-batch` | ZK receipt writing (batched) | (planned) |
| `webhook` | Webhook dispatch | (planned) |
| `bounce` | Bounce processing | (planned) |
| `digest` | Digest batch compilation | (planned) |

### Job Configuration

```typescript
{
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 1000 },  // keep last 1000
  removeOnFail: { count: 5000 },
}
```

---

## 10. Database Design

### Zero-PII Principle

The database **never** stores:
- Plaintext email addresses
- Plaintext wallet addresses (stored as SHA-256)
- Plaintext API keys (stored as SHA-256)
- Notification body content

### Key Indexes

| Table | Index | Purpose |
|:------|:------|:--------|
| `protocols` | `idx_protocols_pubkey` | Fast lookup by Solana pubkey |
| `api_keys` | `idx_api_keys_hash` | Auth validation (hash lookup) |
| `notifications` | `idx_notifications_protocol` | Protocol dashboard queries |
| `notifications` | `idx_notifications_wallet` | Wallet-scoped queries |
| `notifications` | `idx_notifications_status` | Status-based filtering |
| `notifications` | `idx_notifications_idem` | Idempotency lookups |

---

## 11. Solana Integration

### Herald SDK Usage

The gateway uses `@herald-protocol/sdk` `ReadClient` for read-only operations:

```typescript
// Initialization (SolanaService constructor)
this.readClient = new ReadClient({
  rpcUrl: rpcManager.getConnection().rpcEndpoint,
  programId: config.get('HERALD_PROGRAM_ID'),
  commitment: 'confirmed',
});

// Identity lookup
const identity = await readClient.fetchIdentityAccount(new PublicKey(wallet));
// Returns: { owner, encryptedEmail, emailHash, nonce, optInAll, ... }
```

### RPC Circuit Breaker

```
Normal:   Helius RPC (primary)
          │
          ├── 5+ consecutive failures
          │
          ▼
Failover: QuickNode RPC (fallback)
          │
          ├── 30s recovery timer
          │
          ▼
Recovery: Try Helius again
```

---

## 12. Security Architecture

### Defense Layers

| Layer | Mechanism | File |
|:------|:----------|:-----|
| Transport | Helmet (security headers) | `main.ts` |
| Authentication | Bearer API key → SHA-256 → cache → DB | `auth.guard.ts` |
| Authorization | Scope-based permissions | `scope.guard.ts` |
| Rate Limiting | Redis ZADD sliding window | `rate-limit.service.ts` |
| Input Validation | class-validator (whitelist mode) | `main.ts` (global pipe) |
| PII Protection | SHA-256 hashing, TEE decryption | `notify.service.ts`, `enclave.service.ts` |
| Logging | PII-redacted structured logs | `logging.interceptor.ts` |
| Error Handling | Stack traces hidden in production | `exception.filter.ts` |

### SEC-001: Email Lifecycle

The plaintext email exists **only** in the `email` local variable inside `MailWorker.process()`.
It is:
1. Obtained from TEE (`enclaveService.decrypt()`)
2. Passed to `mailService.send()` as the `to` field
3. Automatically garbage collected when `process()` returns

It is **never**: logged, persisted, cached, or included in job payloads.

---

## 13. Configuration & Validation

### Startup Validation

All environment variables are validated at startup via Zod:

```typescript
// configuration.schema.ts
export const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  MAIL_PROVIDER: z.enum(['smtp', 'resend', 'ses']).default('smtp'),
  // ... 40+ variables
});
```

If validation fails: **the application crashes immediately** with a clear error message.
This prevents silent misconfiguration from reaching production.

---

## 14. Error Handling

### Exception Hierarchy

```
HttpException (NestJS built-in)
└── HeraldException (base class)
    ├── WalletNotRegisteredException   → 404
    ├── RateLimitExceededException     → 429
    ├── RoutingUnavailableException    → 503
    └── RegistryUnavailableException   → 503
```

### Global Exception Filter Response Format

```json
{
  "statusCode": 429,
  "error": "RATE_LIMIT_EXCEEDED",
  "message": "Rate limit exceeded. Retry after 1 second.",
  "timestamp": "2026-03-20T09:00:00.000Z",
  "path": "/v1/notify",
  "correlationId": "a1b2c3d4-..."
}
```

Stack traces are included in `development` mode only.
