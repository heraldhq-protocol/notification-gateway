# Herald Encryption Architecture

> **Last updated:** May 2026  
> **Status:** Phase 1 — Direct Mode with dual-recipient encryption  
> **Phase 2 (Nitro Enclave):** Planned when budget allows (~$130/mo for `c5.xlarge`)

---

## Overview

Herald encrypts user contact details (email, Telegram ID, phone) before they are stored on the Solana blockchain. The system is **two-way**:

- **The Herald Notification Gateway** can decrypt contacts to deliver notifications
- **The user** can decrypt their own stored email in the portal using their wallet key

This document covers the cryptographic design, all three operational modes, the dual-encryption blob format, environment variables, and the Phase 2 Nitro Enclave migration path.

---

## The Two-Way Requirement

The core design goal is that **both parties** can independently decrypt the on-chain email without needing to trust the other:

| Party | Key | Can decrypt |
|---|---|---|
| Herald Gateway | `HERALD_X25519_PRIV_HEX` (in Secrets Manager) | Gateway block of the dual blob |
| User | Wallet Ed25519 secret key (never leaves browser) | User block of the dual blob |

Neither party can read the other's private key. The encryption is non-interactive — both blocks are written at registration time in the user's browser.

---

## The Three Operational Modes

```
                     ┌─────────────────────────────────────────────────────┐
                     │           Mode Selection (Gateway)                  │
                     │                                                     │
                     │   HERALD_X25519_PRIV_HEX set?                       │
                     │         │ yes                    │ no               │
                     │         ▼                        ▼                  │
                     │   ┌─ DIRECT ─┐        ENCLAVE_MODE=sandbox?         │
                     │   │ in-proc  │            │ yes      │ no           │
                     │   │ nacl.box │            ▼          ▼              │
                     │   └──────────┘       ┌─SANDBOX─┐  ┌─NITRO─┐        │
                     │                      │secretbox│  │socket │        │
                     │                      └─────────┘  └───────┘        │
                     └─────────────────────────────────────────────────────┘
```

### Mode 1 — Direct (Current Production) ✅

No extra cost. No special infrastructure. Key held in Secrets Manager.

**Portal encrypts** using the **dual-recipient nacl.box** format (see below).  
**Gateway decrypts** the gateway block in-process using `HERALD_X25519_PRIV_HEX`.  
**User decrypts** the user block in the browser using their wallet key.

Activated automatically when `HERALD_X25519_PRIV_HEX` is present in Secrets Manager.

---

### Mode 2 — Sandbox (Devnet / Local) 🧪

For development and testing only. Uses a shared symmetric key.

**Portal encrypts** with `nacl.secretbox` using `NEXT_PUBLIC_ENCLAVE_TEST_KEY`.  
**Gateway decrypts** with the same key.  
**User self-decryption is not available** in sandbox — use `GET /portal/email` (admin-api).

Activated when `NEXT_PUBLIC_RPC_CLUSTER=devnet` or `ENCLAVE_MODE=sandbox`.

---

### Mode 3 — Nitro Enclave (Phase 2) 🔒

Hardware TEE isolation. ~$130/mo on `c5.xlarge`.

**Portal encrypts** using the same dual-format blob as Direct mode — **no portal changes needed**.  
**Gateway sends** the gateway block to the Nitro Enclave via Unix socket.  
**User decrypts** their block in the browser exactly as in Direct mode — **no change**.

Transition: remove `HERALD_X25519_PRIV_HEX` from Secrets Manager → gateway falls through to socket.

---

## The Dual-Encryption Blob Format

### On-chain blob structure

```
Byte offset   Content
───────────   ─────────────────────────────────────────────────────────
0–1           Magic: [0xAA, 0xBB]  (identifies dual format)
2–33          ephemeral1_pub (32 bytes)  — sender for gateway block
34–35         len (uint16 big-endian)   — length of each ciphertext block
36–(36+len)   gateway_ciphertext        — nacl.box to Herald gateway pubkey
(+0)–(+31)   ephemeral2_pub (32 bytes)  — sender for user block
(+32)–end    user_ciphertext           — nacl.box to user wallet X25519 pubkey
```

Both ciphertext blocks are encrypted with the **same nonce** (stored separately in `IdentityAccount.nonce`). This is safe because the two blocks use completely different DH shared secrets.

### Size budget (200-byte on-chain limit)

```
Magic:          2 bytes
eph1:          32 bytes
len:            2 bytes
gateway_cipher: N + 16 bytes  (N = email UTF-8 length, 16 = NaCl MAC)
eph2:          32 bytes
user_cipher:    N + 16 bytes
─────────────────────────────
Total:         100 + 2N ≤ 200  →  N ≤ 50 bytes (50 ASCII characters)
```

**50-character limit for dual format.** Covers the vast majority of real-world email addresses. For emails > 50 bytes, the portal falls back to gateway-only encryption (single format); the user can view their email via the authenticated `GET /portal/email` API endpoint.

### Legacy single format (backward compat)

Old blobs (before dual encryption was introduced) follow:
```
[ephemeral_pub (32 bytes)] [nacl.box ciphertext]
```

The gateway's `directNaclBoxDecrypt()` automatically detects the format by checking the `0xAA 0xBB` magic prefix. All three formats (dual, legacy, secretbox) are handled transparently.

---

## Why `walletPubkey` Is Used in `encryptEmail`

```ts
export async function encryptEmail(
  email: string,
  walletPubkey: PublicKey,  // ← now actively used for Block 2
): Promise<{ encryptedEmail: Uint8Array; nonce: Uint8Array }>
```

`walletPubkey` is **used** in production mode: it's converted from Ed25519 → X25519 (using `deriveX25519FromEd25519` from the SDK) to create the user's encryption block. It is **not used** in sandbox mode (secretbox with a shared key).

---

## User Self-Decryption in the Portal

The portal exposes `decryptEmailForUser()` from `lib/crypto.ts`:

```ts
import { decryptEmailForUser, isDualEncryptedBlob } from '@/lib/crypto';

// In a settings page or "verify your email" component:
const email = decryptEmailForUser(
  identity.encryptedEmail,  // Uint8Array from on-chain
  identity.nonce,
  wallet.secretKey,         // Ed25519 64-byte key from wallet adapter
);

if (email) {
  // User can see their stored email — fully client-side, no server round-trip
  showEmail(email);
} else {
  // Sandbox or gateway-only blob — fetch from admin-api instead
  fetchStoredEmailFromApi();
}
```

**What the user can do:**
- Register → email stored on-chain (dual-encrypted)
- Open portal settings → `decryptEmailForUser()` decrypts Block 2 in the browser using wallet key
- Update email → new dual-encrypted blob written on-chain
- No server trust required for email verification

---

## Data Flow — Registration to Delivery

```
USER BROWSER (Portal)
─────────────────────────────────────────────────────────────────────────
1. User enters email → encryptEmail(email, walletPubkey)

   [Production — email ≤ 50 chars]
   nonce = random 24 bytes
   eph1, eph2 = two random ephemeral keypairs
   Block 1 = nacl.box(email, nonce, heraldGatewayX25519PubKey, eph1.secret)
   Block 2 = nacl.box(email, nonce, userWalletX25519PubKey,    eph2.secret)
   blob = [0xAA,0xBB] [eph1.pub] [len] [Block1] [eph2.pub] [Block2]

   [Sandbox]
   blob = nacl.secretbox(email, nonce, ENCLAVE_TEST_KEY)

2. blob + nonce stored on-chain via Solana transaction

SOLANA BLOCKCHAIN
─────────────────────────────────────────────────────────────────────────
3. IdentityAccount { encrypted_email: blob, nonce } persisted

USER BROWSER (viewing stored email)
─────────────────────────────────────────────────────────────────────────
4. decryptEmailForUser(blob, nonce, wallet.secretKey)
   → detects magic [0xAA, 0xBB]
   → skips Block 1 (gateway)
   → nacl.box.open(Block2, nonce, eph2.pub, walletX25519SecretKey)
   → returns plaintext email ✅ (in browser, no server involved)

HERALD NOTIFICATION GATEWAY (ECS Fargate)
─────────────────────────────────────────────────────────────────────────
5. Protocol sends notification → POST /notify/{walletPubkey}
6. RoutingService.resolveIdentity() → fetch IdentityAccount (Redis-cached)
7. EnclaveService.decryptAllChannels(identity)
   → directNaclBoxDecrypt(blob, nonce):
     detects magic [0xAA, 0xBB]
     → nacl.box.open(Block1, nonce, eph1.pub, HERALD_X25519_PRIV_HEX)
     → plaintext email IN MEMORY ONLY
8. Email delivered via SES / Resend
9. Plaintext email discarded from memory
```

---

## Environment Variables

### Gateway (AWS Secrets Manager — `herald-gateway/staging`)

| Key | Mode | Description |
|---|---|---|
| `HERALD_X25519_PRIV_HEX` | Direct | 32-byte X25519 private key (64 hex chars). Activates direct mode. |
| `ENCLAVE_TEST_KEY` | Sandbox | 32-byte base64 symmetric key for secretbox decryption. |
| `NITRO_ENCLAVE_SOCKET` | Nitro | Path to Unix socket, default `/run/herald-enclave/enclave.sock`. |

### Portal (Vercel / Next.js env)

| Key | Mode | Description |
|---|---|---|
| `NEXT_PUBLIC_HERALD_ENCLAVE_PUBKEY_HEX` | Direct/Nitro | 64-char hex public key. Public counterpart of `HERALD_X25519_PRIV_HEX`. Safe to expose client-side. |
| `NEXT_PUBLIC_ENCLAVE_TEST_KEY` | Sandbox | Same value as `ENCLAVE_TEST_KEY` above. |
| `NEXT_PUBLIC_ENCLAVE_MODE` | Sandbox | Set to `sandbox` to force sandbox mode. Leave unset for production. |
| `NEXT_PUBLIC_RPC_CLUSTER` | Sandbox trigger | `devnet` or `localhost` also triggers sandbox mode. |

---

## Generating the Gateway Keypair

```bash
node -e "
const nacl = require('tweetnacl');
const kp = nacl.box.keyPair();
console.log('HERALD_X25519_PRIV_HEX (→ AWS Secrets Manager):');
console.log(Buffer.from(kp.secretKey).toString('hex'));
console.log('');
console.log('NEXT_PUBLIC_HERALD_ENCLAVE_PUBKEY_HEX (→ Portal env):');
console.log(Buffer.from(kp.publicKey).toString('hex'));
"
```

> [!CAUTION]
> Generate separate keypairs for staging and production. Never commit the private key.

---

## Phase 2: Migrating to Nitro Enclave

**No portal changes required.** The dual-format blob is identical for Direct and Nitro modes.

### Steps
1. Build the EIF — see [`docs/nitro-enclave-setup.md`](./nitro-enclave-setup.md)
2. Launch enclave-enabled EC2 (`c5.xlarge`, `--enclave-enabled` at launch)
3. Start enclave + vsock proxy (systemd services in setup guide)
4. Remove `HERALD_X25519_PRIV_HEX` from Secrets Manager → gateway uses socket path
5. Add `NITRO_ENCLAVE_SOCKET=/run/herald-enclave/enclave.sock` to Secrets Manager
6. Deploy `task-definition.gateway-nitro.json` via `git tag v1.0.0-nitro && git push origin v1.0.0-nitro`

### Security comparison

| Property | Direct (MVP) | Nitro Enclave |
|---|---|---|
| Private key location | Secrets Manager → Node.js heap | Inside Nitro TEE — never in OS memory |
| IAM access to key | Any process with the task role | Nobody (PCR attestation only) |
| KMS attestation | Optional | Mandatory |
| Tamper evidence | None | PCR0/PCR1/PCR2 hashes |
| Extra cost | $0 | ~$130/mo |

---

## Files Changed

| File | Change |
|---|---|
| `herald-user-portal/lib/crypto.ts` | Dual encryption, `decryptEmailForUser()`, `isDualEncryptedBlob()`, `walletPubkey` now used |
| `herald-user-portal/components/preferences/EmailUpdateModal.tsx` | Import fixed to use `lib/crypto.ts` instead of SDK directly |
| `herald-user-portal/.env.example` | Added `NEXT_PUBLIC_HERALD_ENCLAVE_PUBKEY_HEX` |
| `herald-notification-gateway/src/modules/routing/enclave.service.ts` | Added direct mode, `directNaclBoxDecrypt` handles all 3 formats |
| `herald-notification-gateway/docker/task-definition.gateway.json` | `ENCLAVE_MODE=sandbox` set; add `HERALD_X25519_PRIV_HEX` secret to activate direct mode |

---

## FAQ

**Q: Do users need to re-register after this change?**  
A: No. The gateway automatically tries all three blob formats. Old sandbox-registered wallets continue to work.

**Q: Can the gateway decrypt the user's block (Block 2)?**  
A: No. Block 2 is encrypted to the user's wallet X25519 key. The gateway doesn't have the user's private key.

**Q: Can the user decrypt the gateway's block (Block 1)?**  
A: No. Block 1 is encrypted to the Herald gateway X25519 key. The user doesn't have the gateway private key.

**Q: What about Telegram ID and phone? Are those dual-encrypted too?**  
A: Currently no — `lib/crypto.ts` only implements dual encryption for email. Telegram and SMS channels use the gateway-only format. This can be extended using the same pattern.

**Q: What if the email is longer than 50 characters?**  
A: The portal falls back to gateway-only single format. The user can see their stored email via `GET /portal/email` (authenticated admin-api endpoint). This covers <5% of real-world email addresses.
