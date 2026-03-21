---
name: api-design
description: Expert REST, WebSocket, and gRPC API design for B2B SaaS products, developer SDKs, and Web3 protocols. Use this skill when the user asks to design an API, write API documentation, plan API versioning, design webhook systems, create OpenAPI specs, build SDK-friendly interfaces, design rate limiting strategies, or structure API error responses. Also trigger for API authentication patterns (API keys, JWT, OAuth), pagination design, idempotency keys, and developer experience (DX) best practices. If the task involves designing how external clients will consume a service — use this skill.
---

# API Design Skill

You design APIs that developers love to use. Every endpoint is a product decision. Every error message is a UX moment. Think like a developer consuming your API, not just the engineer building it.

## REST API Design Principles

### URL Structure
```
# Resources are nouns, not verbs
GET    /v1/notifications              # list
GET    /v1/notifications/:id          # fetch one
POST   /v1/notifications              # create
PATCH  /v1/notifications/:id          # partial update
DELETE /v1/notifications/:id          # delete

# Sub-resources
GET    /v1/tenants/:tenantId/notifications
POST   /v1/tenants/:tenantId/notifications/batch

# Actions (when REST doesn't fit)
POST   /v1/notifications/:id/resend   # action on resource
POST   /v1/notifications/batch        # bulk operation
```

### Versioning Strategy
```
# URI versioning (recommended for breaking changes)
/v1/notifications
/v2/notifications

# Header versioning (for minor variants)
API-Version: 2024-03-01

# Deprecation lifecycle
1. Announce deprecation → add Deprecation + Sunset headers
2. 6-month grace period
3. Return 410 Gone after sunset date

Deprecation: true
Sunset: Sat, 01 Sep 2025 00:00:00 GMT
Link: <https://docs.herald.app/migration/v2>; rel="successor-version"
```

### Response Structure (always consistent)
```typescript
// Success
{
  "data": { ... },           // the resource or array
  "meta": {                  // pagination, counts, etc.
    "total": 1243,
    "page": 1,
    "per_page": 20,
    "next_cursor": "eyJpZCI6..."
  }
}

// Error — always this shape, no exceptions
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",      // machine-readable, SCREAMING_SNAKE
    "message": "You have exceeded...",  // human-readable, complete sentence
    "status": 429,
    "request_id": "req_abc123",         // for support/debugging
    "docs_url": "https://docs.herald.app/errors/rate-limit",
    "details": [                        // validation errors only
      { "field": "recipient", "message": "Invalid email format" }
    ]
  }
}
```

### HTTP Status Codes (use precisely)
```
200 OK              - Success (GET, PATCH)
201 Created         - Resource created (POST)
202 Accepted        - Async job started
204 No Content      - Success, no body (DELETE)
400 Bad Request     - Client validation error
401 Unauthorized    - Missing/invalid auth
403 Forbidden       - Authenticated but no permission
404 Not Found       - Resource doesn't exist
409 Conflict        - Duplicate / state conflict
422 Unprocessable   - Semantic validation error
429 Too Many Requests - Rate limited
500 Internal Error  - Our fault
503 Service Unavail - Degraded / maintenance
```

## Authentication Design

### API Key Pattern (for B2B/developer APIs)
```typescript
// Key format: prefix_base62(32bytes)
// Example: hrl_live_4xK9mN2pQr8sT6uV3wX1yZ0aB5cD7eF
//          ^^^  ^^^^  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
//          org  env   random token (stored as HMAC-SHA256 hash)

// Request header
Authorization: Bearer hrl_live_4xK9mN2pQr8sT6uV3wX1yZ0aB5cD7eF
// or
X-API-Key: hrl_live_4xK9mN2pQr8sT6uV3wX1yZ0aB5cD7eF

// NestJS Guard
@Injectable()
export class ApiKeyGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const raw = req.headers['x-api-key'] ?? extractBearer(req);
    if (!raw) throw new UnauthorizedException('API key required');

    const hash = createHmac('sha256', process.env.API_KEY_SECRET!)
      .update(raw)
      .digest('hex');

    const tenant = await this.db.apiKeys.findOne({
      where: { key_hash: hash, revoked_at: IsNull() }
    });
    if (!tenant) throw new UnauthorizedException('Invalid API key');

    req.tenant = tenant;
    return true;
  }
}
```

## Idempotency

Critical for payment and notification APIs:
```typescript
// Client sends Idempotency-Key header
// POST /v1/notifications
// Idempotency-Key: uuid-v4-here

@Post()
async create(
  @Headers('idempotency-key') idempotencyKey: string,
  @Body() dto: CreateNotificationDto,
  @Req() req: TenantRequest,
) {
  const cacheKey = `idempotency:${req.tenant.id}:${idempotencyKey}`;
  
  const cached = await this.redis.get(cacheKey);
  if (cached) return JSON.parse(cached); // return original response
  
  const result = await this.notificationService.create(dto, req.tenant);
  
  // Cache for 24 hours
  await this.redis.setex(cacheKey, 86400, JSON.stringify(result));
  return result;
}
```

## Webhook Design

```typescript
// Webhook payload — always this shape
interface WebhookPayload {
  id: string;               // unique event ID (idempotency key for receiver)
  type: 'notification.delivered' | 'notification.failed';
  api_version: string;      // "2024-03-01"
  created_at: string;       // ISO 8601
  data: {
    object: NotificationObject;
    previous_attributes?: Partial<NotificationObject>; // what changed
  };
}

// Delivery: sign every payload with HMAC-SHA256
const signature = createHmac('sha256', webhookSecret)
  .update(`${timestamp}.${JSON.stringify(payload)}`)
  .digest('hex');

// Headers sent to client endpoint
Webhook-Signature: t=1714000000,v1=abc123...
Webhook-ID: evt_abc123
Webhook-Timestamp: 1714000000

// Receiver validates
const [t, v1] = header.split(',');
const timestamp = t.split('=')[1];
const expected = createHmac('sha256', secret)
  .update(`${timestamp}.${rawBody}`)
  .digest('hex');
// reject if |now - timestamp| > 5 minutes (replay protection)
```

## Rate Limiting

```typescript
// Sliding window rate limit with Redis
// Headers returned on every request
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 847
X-RateLimit-Reset: 1714003600
Retry-After: 60   // only on 429

// Tiered limits by plan
const RATE_LIMITS = {
  free:       { requests: 100,    window: 60 },
  starter:    { requests: 1_000,  window: 60 },
  growth:     { requests: 10_000, window: 60 },
  enterprise: { requests: 100_000, window: 60 },
};
```

## Pagination

```typescript
// Cursor-based (preferred for real-time data)
GET /v1/notifications?limit=20&after=eyJpZCI6MTIz

// Response
{
  "data": [...],
  "meta": {
    "has_more": true,
    "next_cursor": "eyJpZCI6MTQ2,
    "previous_cursor": "eyJpZCI6MTAw"
  }
}

// Offset-based (only for admin/report endpoints)
GET /v1/notifications?page=2&per_page=20
```

## OpenAPI Spec Template

```yaml
openapi: "3.1.0"
info:
  title: Herald API
  version: "1.0.0"
  description: |
    Privacy-preserving notification API for Solana protocols.
    
    **Base URL**: `https://api.herald.app/v1`
    
    **Authentication**: Pass your API key as `Bearer` token in `Authorization` header.

servers:
  - url: https://api.herald.app/v1
    description: Production
  - url: https://sandbox.herald.app/v1
    description: Sandbox

components:
  securitySchemes:
    ApiKeyAuth:
      type: http
      scheme: bearer
      description: "Your Herald API key"

security:
  - ApiKeyAuth: []

paths:
  /notifications:
    post:
      summary: Send a notification
      operationId: createNotification
      tags: [Notifications]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateNotificationRequest'
            examples:
              basic:
                summary: Basic email notification
                value:
                  recipient_wallet: "7xKwB..."
                  channel: email
                  template_id: "position_liquidation"
                  data: { collateral_ratio: 1.05 }
      responses:
        '201':
          description: Notification queued
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Notification'
        '400':
          $ref: '#/components/responses/BadRequest'
        '429':
          $ref: '#/components/responses/RateLimited'
```

## SDK Design Principles

When your API will have an SDK:
```typescript
// SDK should feel like this to consume — not like REST
const herald = new Herald({ apiKey: 'hrl_live_...' });

// Fluent / builder-style for complex operations  
await herald.notifications
  .to('7xKwB...')        // wallet address
  .via('email')          // channel
  .using('liq_warning')  // template
  .with({ ratio: 1.05 }) // template data
  .send();

// Not this (raw REST wrapper)
await herald.post('/notifications', {
  recipient_wallet: '7xKwB...',
  channel: 'email',
  template_id: 'liq_warning',
  data: { ratio: 1.05 }
});
```

## Output Format

When designing an API:
1. Define resources and their relationships first
2. Write the core CRUD endpoints
3. Identify async operations (return 202 + job ID)
4. Design error codes exhaustively
5. Write at least one OpenAPI path definition
6. Specify rate limiting strategy
7. Show SDK-level interface if applicable