---
name: herald-context
description: Deep context about Herald — the privacy-preserving B2B notification API for Solana DeFi protocols. Use this skill when the user asks about Herald's architecture, positioning, product decisions, fundraising, go-to-market strategy, ICP (ideal customer profile), technical design, API design, pricing model, or anything specific to the Herald product or startup. Also trigger when the user is writing content, pitching investors, designing features, or making technical decisions in the context of Herald. This skill provides the background context that makes all other skills more accurate and relevant for Herald-specific work.
---

# Herald — Project Context Skill

## What Herald Is

**Herald** is a privacy-preserving B2B notification API for Solana DeFi protocols — the "SendGrid of Web3."

**One-liner**: Protocols send a wallet address. Herald handles secure, private delivery via email, push, or webhook — without ever seeing who the user is.

**Core insight**: DeFi protocols desperately need to communicate with users (liquidation warnings, governance votes, position updates) but have no reliable, privacy-respecting way to do so. Email requires collecting PII. Existing push services aren't chain-aware. Herald bridges this gap.

## Product Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         HERALD PLATFORM                         │
├─────────────────────────────────────────────────────────────────┤
│  Protocol SDK (TypeScript)                                      │
│  → herald.notify(walletAddress, templateId, data)               │
├─────────────────────────────────────────────────────────────────┤
│  REST API  →  Validation  →  Dedup  →  BullMQ Queue            │
├─────────────────────────────────────────────────────────────────┤
│  Delivery Workers                                               │
│  → Email (user-registered, protocol never sees it)             │
│  → Push Notification (mobile)                                   │
│  → Webhook (for protocol's own systems)                         │
├─────────────────────────────────────────────────────────────────┤
│  Privacy Layer                                                  │
│  → Wallet ↔ Contact mapping (encrypted, tenant-isolated)       │
│  → Protocol sees only: delivery status (delivered/failed)      │
└─────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | NestJS (TypeScript) |
| Queue | BullMQ + Redis Streams |
| Database | PostgreSQL (with RLS for tenant isolation) |
| Cache | Redis |
| Email delivery | AWS SES + SendGrid adapter (pluggable) |
| Chain indexer | Helius webhooks + custom parser |
| SDK | TypeScript (`@herald-protocol/sdk`) |
| Auth | HMAC-signed API keys (`hrl_live_...`) |

## Ideal Customer Profile (ICP)

**Primary**: Mid-to-large Solana DeFi protocols
- Marginfi, Kamino, Drift, Meteora, Orca, Realms, Squads, Save
- Engineering team of 3+
- Has active users who lose money due to missed alerts
- Cares about user retention, not just TVL

**Decision maker**: Protocol founder or lead engineer
**Pain trigger**: User complaint about missed liquidation, governance vote with low participation

## Business Model

- **B2B SaaS API** — pay-per-notification + monthly base fee
- Pricing tiers: Free (dev/testing) → Growth → Enterprise
- Target: $1.2M seed raise
- Revenue model mirrors Twilio/SendGrid (usage-based + seat-based)

## Privacy Architecture (Key Differentiator)

The protocol knows nothing about who the user is:
```
1. User registers contact info with Herald (not the protocol)
   → User goes to herald.app, connects wallet, enters email
   → Herald stores: { wallet: "7xKwB...", email_hash: hash(email), encrypted_email: enc(email) }

2. Protocol sends notification:
   → herald.notify("7xKwB...", "liquidation_warning", { ratio: 1.05 })
   → Herald decrypts email internally, delivers it
   → Protocol receives: { status: "delivered" } — no PII

3. Protocol never learns the user's email
```

## Current Status

- Brand, logo, and design system: complete
- Technical architecture: designed (SRS complete)
- Pitch deck: complete (18 slides)
- Financial model: complete
- Twitter content campaign: 30-day plan in execution
- Primary research: actively interviewing Marginfi, Kamino, Drift, Meteora, Realms, Squads, Save, Orca
- Fundraise target: $1.2M seed

## Positioning vs Alternatives

| Solution | Problem |
|----------|---------|
| Protocol-built emails | PII collection, GDPR risk, high eng effort |
| Discord/Telegram bots | Fragmented, opt-in friction, no on-chain trigger |
| Generic push services | Not Solana-aware, no wallet-to-contact mapping |
| **Herald** | Chain-native, privacy-preserving, plug-in SDK |

## Technical Decisions Made

1. **BullMQ over Kafka** — operational simplicity at early stage, Redis already in stack
2. **Row-level multi-tenancy** — simpler than schema-per-tenant, PostgreSQL RLS enforces isolation
3. **Encrypted wallet-contact mapping** — AES-256, key per tenant, Herald sees hash only
4. **Idempotent delivery** — dedup by (tenant_id, wallet_address, template_id, dedup_key)
5. **TypeScript monorepo** — SDK, API, workers share types via workspace packages

## Key Framing for Pitches / Content

**The narrative**: DeFi has a retention problem, not a product problem. Users churn because they get liquidated silently, miss governance votes, or don't know when positions need attention. Protocols spend millions building features but lose users to silent failures. Herald is the communication layer that turns one-time users into loyal protocol participants.

**Why Solana**: Solana is the fastest-growing DeFi ecosystem with the most sophisticated on-chain activity. Protocols are scaling, users are growing, but the notification infrastructure is still at Web2 1.0. This is a timing-specific opportunity.

**Why now**: Token-2022, compressed NFTs, and high-frequency DeFi activity mean more events that need user attention. The gap between on-chain activity frequency and user awareness is widening.

## When Helping with Herald Tasks

- **API design**: Follow the patterns in `api-design` skill, use `hrl_live_` key prefix
- **System design**: Prioritize privacy architecture — the encryption layer is non-negotiable
- **Code**: Herald's SDK method signature: `herald.notify(wallet, templateId, data, options?)`