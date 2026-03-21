---
name: security-audit
description: Smart contract security auditing, backend API security reviews, and Web3 attack vector analysis. Use this skill when the user asks to audit a Solana/Anchor program, review code for vulnerabilities, check for common attack vectors (reentrancy, privilege escalation, arithmetic overflow, PDA collisions, missing signer checks), perform threat modeling, review API security, or assess the security posture of a system. Also trigger for questions about access control design, input sanitization, secret management, OWASP compliance, and cryptographic pattern validation. If the user says "is this secure", "audit this", "can this be exploited", or "what are the security risks" — use this skill.
---

# Security Audit Skill

You approach every codebase as an adversarial reviewer. Assume the attacker knows your code (security through obscurity is not security). Every assumption is a potential vulnerability.

## Solana / Anchor Security Audit Checklist

### Critical (break immediately if found)

#### 1. Missing Signer Checks
```rust
// ❌ CRITICAL: Anyone can call this
pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    // no check that caller owns the vault
    token::transfer(cpi_ctx, amount)?;
    Ok(())
}

// ✅ Fixed: authority is a Signer, linked to vault via has_one
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = authority @ ErrorCode::Unauthorized)]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>, // ← must sign
}
```

#### 2. Missing Ownership Checks
```rust
// ❌ CRITICAL: token_account could be any account
pub token_account: Account<'info, TokenAccount>,

// ✅ Fixed: constrain the mint and authority
#[account(
    mut,
    token::mint = expected_mint,
    token::authority = authority,
)]
pub token_account: Account<'info, TokenAccount>,
```

#### 3. Arithmetic Overflow/Underflow
```rust
// ❌ CRITICAL: Will panic in debug, wrap in release
let new_balance = vault.balance + deposit_amount;

// ✅ Fixed: always use checked arithmetic
let new_balance = vault.balance
    .checked_add(deposit_amount)
    .ok_or(ErrorCode::ArithmeticOverflow)?;

// For percentage calculations, use basis points (avoid floats)
let fee = amount
    .checked_mul(fee_bps as u64)? // e.g. 30 = 0.3%
    .checked_div(10_000)?
    .ok_or(ErrorCode::ArithmeticOverflow)?;
```

#### 4. PDA Derivation Issues
```rust
// ❌ VULNERABLE: User-controlled seed can cause collision
seeds = [b"vault", user_input.as_bytes()],

// ✅ Fixed: use canonical, type-safe seeds
seeds = [b"vault", authority.key().as_ref(), &[vault_index]],

// ❌ VULNERABLE: Not verifying bump on reload
#[account(seeds = [b"vault"], bump)]  // auto-finds bump, expensive + risky

// ✅ Fixed: store and verify canonical bump
#[account(
    seeds = [b"vault"],
    bump = vault.bump,  // stored bump, verified on every access
)]
```

#### 5. Re-initialization / Discriminator Attacks
```rust
// ❌ VULNERABLE: Can reinitialize existing accounts
#[account(init_if_needed, payer = user, space = 8 + State::INIT_SPACE)]
pub state: Account<'info, State>,

// ✅ Only use init_if_needed if you explicitly handle the already-initialized case
// and validate that re-initialization doesn't bypass invariants
```

#### 6. CPI Target Verification
```rust
// ❌ VULNERABLE: Attacker passes malicious token_program
pub token_program: AccountInfo<'info>,

// ✅ Fixed: use typed program accounts
pub token_program: Program<'info, Token>,
// or for Token-2022
pub token_program: Interface<'info, TokenInterface>,
```

### High Severity

#### 7. Flash Loan / Atomic Manipulation
```rust
// Check for price oracle usage within same transaction
// If protocol reads price → acts on it → all in one tx → flash loan risk
// Mitigation: use time-weighted prices (TWAP), or Switchboard's on-demand with
// staleness checks

require!(
    Clock::get()?.unix_timestamp - oracle_price.last_update_time < MAX_STALENESS,
    ErrorCode::StalePriceData
);
```

#### 8. Integer Truncation
```rust
// ❌ VULNERABLE: Truncation loss
let fee = (amount * fee_bps / 10_000) as u64; // if these are u128 cast to u64

// ✅ Fixed: validate range before cast
let fee_u128 = (amount as u128)
    .checked_mul(fee_bps as u128)?
    .checked_div(10_000)?;
require!(fee_u128 <= u64::MAX as u128, ErrorCode::Overflow);
let fee = fee_u128 as u64;
```

#### 9. Account Data Reallocation
```rust
// When using realloc, ensure new space ≥ old space if storing versioned data
// and always zero-initialize new bytes
#[account(
    mut,
    realloc = 8 + NewState::INIT_SPACE,
    realloc::payer = authority,
    realloc::zero = true,  // ← critical: zero new bytes
)]
pub state: Account<'info, NewState>,
```

### Medium Severity

#### 10. Denial of Service via Account Bloat
```rust
// ❌ VULNERABLE: Unbounded vec allows storage exhaustion attack
pub struct State {
    pub items: Vec<Item>,  // attacker can fill this indefinitely
}

// ✅ Fixed: cap all vectors
pub struct State {
    #[max_len(100)]
    pub items: Vec<Item>,  // anchor enforces max at deserialization
}
```

#### 11. Missing close = target
```rust
// ❌ Account lamports go nowhere / rent exploit
#[account(mut, close)]  // missing close target

// ✅ Always specify refund destination
#[account(mut, close = authority)]
pub escrow: Account<'info, Escrow>,
```

## Backend API Security Audit

### OWASP Top 10 Checklist

- [ ] **Injection**: All DB queries use parameterized statements (TypeORM prevents this if used correctly)
- [ ] **Broken Auth**: JWT expiry < 1hr, refresh tokens rotated on use, API keys hashed in DB
- [ ] **Sensitive Data**: PII encrypted at rest (AES-256), no PII in logs, HTTPS-only
- [ ] **Mass Assignment**: DTOs with explicit `@IsOptional()` only on fields users can set
- [ ] **Security Misconfiguration**: CORS allowlist (not `*`), security headers (helmet.js), no stack traces in prod errors
- [ ] **SSRF**: Validate and blocklist internal IPs on any user-provided URLs (webhooks!)
- [ ] **Logging**: Log all auth events, admin actions, errors — never log secrets or tokens

### NestJS Security Patterns
```typescript
// main.ts — production hardening
app.use(helmet());
app.enableCors({ origin: ALLOWED_ORIGINS });
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,           // strip unknown properties
  forbidNonWhitelisted: true,// reject unknown properties
  transform: true,
}));

// Rate limiting
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.tenant?.id ?? req.ip,
}));
```

### Webhook SSRF Protection
```typescript
// ALWAYS validate webhook URLs before making outbound requests
async validateWebhookUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  
  // Block non-HTTPS in production
  if (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new BadRequestException('Webhook URL must use HTTPS');
  }
  
  // Resolve DNS and block private/loopback IPs
  const addresses = await dns.resolve4(parsed.hostname);
  for (const addr of addresses) {
    if (isPrivateIP(addr)) { // use `is-private-ip` package
      throw new BadRequestException('Webhook URL resolves to private IP');
    }
  }
}
```

## Threat Modeling Template (STRIDE)

For each component, evaluate:

| Threat | Category | Mitigation |
|--------|----------|------------|
| Attacker forges API requests | **S**poofing | HMAC-signed requests, API key auth |
| Attacker modifies webhook payload | **T**ampering | HMAC-SHA256 signature verification |
| Attacker denies sending notification | **R**epudiation | Immutable audit log with timestamps |
| Attacker reads encrypted notification data | **I**nfo Disclosure | AES-256 encryption, key per tenant |
| Attacker floods notification endpoint | **D**oS | Rate limiting, queue backpressure |
| Attacker gains admin by privilege escalation | **E**levation | RBAC, least-privilege service accounts |

## Audit Report Format

When delivering a security review:

```markdown
## Security Audit Report — [Component Name]

**Severity Legend**: 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low | ℹ️ Informational

---

### 🔴 CRITICAL-001: Missing signer check in `withdraw` instruction
**Location**: `programs/vault/src/lib.rs:45`
**Impact**: Any account can drain vault funds
**PoC**: 
  Call withdraw with arbitrary authority account (not a signer)
**Fix**: Add `authority: Signer<'info>` and `has_one = authority` constraint
**Status**: Unmitigated

---

### Summary
| Severity | Count | Fixed | Remaining |
|----------|-------|-------|-----------|
| Critical | 1     | 0     | 1         |
| High     | 2     | 1     | 1         |
```

## Output Format

When auditing code:
1. **Scan all account constraints** for missing checks
2. **Check all arithmetic** for overflow paths
3. **Trace all CPIs** — are program accounts typed?
4. **Review all PDAs** — seeds canonical, bumps stored and verified?
5. **Report in severity order** — Critical → High → Medium → Low
6. **Provide fix code** for every finding, not just descriptions