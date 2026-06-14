# Plan — Dual-Recipient (E2E) Encryption for Telegram & SMS

> **Status:** Planned follow-up. Not yet started.
> **Prereq:** On-chain program redeploy + IdentityAccount migration (mainnet upgrade authority).
> **Context:** Extends the email dual-encryption design in [`encryption-architecture.md`](./encryption-architecture.md) to the Telegram and SMS channels.

---

## Why this exists

As of SDK **1.8.1** (`fix: seal Telegram/SMS channel data to gateway key, not user wallet`),
Telegram and SMS are encrypted **gateway-only** — sealed to the Herald gateway's X25519 key
so the gateway can decrypt and deliver. This fixed the original bug where the chat-id/phone
were sealed to the *user's* wallet key and the gateway could never open them.

Email goes one step further: it uses the **dual-recipient** blob (`0xAA 0xBB` format) so
**both** the gateway (for delivery) **and** the user (for in-browser self-decrypt) can read it.
This doc is the plan to bring Telegram/SMS to that same parity.

## The blocker — on-chain field sizes

A dual blob is `100 + 2N` bytes (magic 2 + eph1 32 + len 2 + cipher1 (N+16) + eph2 32 + cipher2 (N+16)).

| Channel | Max plaintext N | Dual blob needs | Current on-chain limit | Fits? |
|---|---|---|---|---|
| Email    | 50 | 200 | `MAX_ENCRYPTED_EMAIL_LEN = 200`        | ✅ |
| Telegram | 15 | ≤130 | `MAX_ENCRYPTED_TELEGRAM_ID_LEN = 80`  | ❌ |
| Phone    | 16 | ≤132 | `MAX_ENCRYPTED_PHONE_LEN = 65`        | ❌ |

Compact variants don't rescue it: even a single-ephemeral, no-magic scheme is ~94 bytes for
Telegram and ~100 for phone — both still exceed the current caps. **The account fields must grow.**

Constants live in
`herald-privacy-registry/programs/herald-privacy-registry/src/constants.rs` and the rent-sizing
`INIT_SPACE` in `.../src/state/identity.rs` (`4 + 80` for telegram, `4 + 65` for phone).

## What already works (no change needed)

- **Gateway.** `directNaclBoxDecrypt` in `src/modules/routing/enclave.service.ts` already detects
  the `0xAA 0xBB` magic and extracts the gateway block, and `directDecryptAll` runs it for
  **all three channels**. A dual-format Telegram/SMS blob would decrypt today with zero gateway changes.

## Implementation steps

1. **On-chain program** (`herald-privacy-registry`)
   - Bump `MAX_ENCRYPTED_TELEGRAM_ID_LEN` and `MAX_ENCRYPTED_PHONE_LEN` to **≥140** each
     (covers `100 + 2·15 = 130` and `100 + 2·16 = 132`, with headroom).
   - Update `INIT_SPACE` in `state/identity.rs` to match (`4 + 140` each).
   - Add an account `realloc` path so existing IdentityAccounts can grow (extra rent — payer = owner
     on next update, or a dedicated migration ix). Confirm rent-exemption top-up handling.
   - Rebuild, bump program version, **redeploy** (mainnet upgrade authority), regenerate IDL.

2. **SDK** (`herald-sdk-ts`)
   - Bump `MAX_ENCRYPTED_TELEGRAM_ID_LEN`/`MAX_ENCRYPTED_PHONE_LEN` in `src/channels/types.ts` to match the program.
   - Add dual-encrypt helpers mirroring the portal's `encryptEmail` dual path (or move the dual
     encoder into the SDK so all channels share it). They must take **both** the gateway X25519
     pubkey and the user's wallet pubkey, and emit the `0xAA 0xBB` blob.
   - Point `buildTelegramRegistrationTx`/`buildSmsRegistrationTx` at the dual helper (they currently
     call `encryptTelegramIdForGateway`/`encryptPhoneForGateway` — gateway-only).
   - Regenerate IDL bindings from the redeployed program.

3. **Portal** (`herald-user-portal`)
   - The TG/SMS pages pass `getGatewayEnclavePubkey()`; they'll also need to pass `publicKey`
     (wallet) for the user block. (`lib/crypto.ts` already does exactly this for email.)
   - Add `decryptTelegramIdForUser` / `decryptPhoneForUser` in `lib/crypto.ts` mirroring
     `decryptEmailForUser` (parse magic → skip gateway block → open user block with wallet key).
   - Surface the values in the preferences UI if desired (currently TG/SMS pages show status only,
     never the stored value — so this is a new capability, optional).
   - Bump `@herald-protocol/sdk` to the new version, `npm install`.

4. **Migration / rollout**
   - Old gateway-only blobs keep working (gateway tries dual then legacy). No forced re-register
     for delivery.
   - Users only get *self-decrypt* of TG/SMS after they re-connect (writes a dual blob), same as
     the email re-seal note in the 1.8.1 fix.

## Decision log

- **2026-06-04** — Shipped gateway-only fix (SDK 1.8.1). Chose "gateway-only now, dual later":
  delivery is unblocked without a program redeploy; dual e2e deferred to this plan because it
  requires enlarging on-chain account fields + a mainnet redeploy + account migration.
