# Changelog

All notable changes to the Herald Notification Gateway will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.4.0] - 2026-05-15

### Added
- **Campaigns module**: `POST /v1/campaigns/:id/enqueue` dispatches a campaign to its target audience segment via BullMQ
- **Scheduled Notifications**: `ScheduleModule.forRoot()` with cron-based delivery for one-shot and recurring sends
- `ProtocolSubscription` table with broadcast endpoint and audience analytics
- `pnpm prisma generate` run to include `Campaign`, `ScheduledNotification`, and `ProtocolSubscription` models

## [0.3.0] - 2026-05-09

### Added
- `ApiRequestLog` model and request logging interceptor (captures method, path, status, latency)
- Protocol name decryption fix using `ENCRYPTION_KEY_ID`
- Analytics trend endpoints (daily volume, delivery rate)
- ZK Compression V2 receipt integration
- Email suppression list with bounce handling
- Resend provider with SQS SES event consumer

### Fixed
- Template data loss bugs in partial updates
- Preheader and footer injection in email previews
- Protocol name resolution from `nameEncrypted`

## [0.2.0] - 2026-04-25

### Added
- Playground sandbox endpoint with 25/day rate limit and devnet PDA resolution
- Custom email templates with DOMPurify XSS sanitization
- E2EE portal viewing via Nitro Enclave secretbox decryption
- DKIM key provisioning service and SES raw email delivery
- BIMI support with AWS SES integration
- Telegram and SMS channel dispatch
- Priority flag and explicit channel selection on notify endpoint
- Sandbox test contacts routing by default
- Real-time quota tracking and cache invalidation API

## [0.1.0] - 2026-04-01

### Added
- Core notification dispatch engine with BullMQ job queue
- SES email delivery with template rendering (MJML)
- Solana on-chain ZK receipt generation with Light Protocol
- Redis-based idempotency and subscription cache
- ECS Fargate deployment with dedicated worker service
- Internal API key bypass for cross-service calls
- SSRF protection and XSS sanitization on all inputs
