import { z } from 'zod';

/**
 * Zod schema for environment variable validation.
 * All env vars are validated at startup — invalid config causes immediate crash.
 */
export const EnvironmentSchema = z.object({
  // ── App ───────────────────────────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'staging', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().default(3000),
  API_VERSION: z.string().default('v1'),
  SERVICE_NAME: z.string().default('herald-gateway'),

  // ── Database ──────────────────────────────────────────────────────
  DATABASE_URL: z.string(),
  DATABASE_POOL_MIN: z.coerce.number().default(2),
  DATABASE_POOL_MAX: z.coerce.number().default(20),

  // ── Redis ─────────────────────────────────────────────────────────
  REDIS_URL: z.string().default('redis://localhost:6379'),
  REDIS_CLUSTER_MODE: z.coerce.boolean().default(false),
  REDIS_TLS: z.coerce.boolean().optional(),

  // ── Solana ────────────────────────────────────────────────────────
  SOLANA_RPC_URL: z.string().url().default('http://localhost:8899'),
  SOLANA_FALLBACK_RPC_URL: z.string().url().optional(),
  HERALD_PROGRAM_ID: z
    .string()
    .default('2pxjAf8tLCakKVDuN4vY51B5TeaEQk4koPuk9NZvWqdf'),

  // ── AWS ───────────────────────────────────────────────────────────
  AWS_REGION: z.string().default('us-east-1'),
  SECRET_ID: z.string().optional(),
  AWS_KMS_KEY_ID: z.string().optional(),
  NITRO_ENCLAVE_SOCKET: z.string().default('/run/enclave.sock'),

  // ── Mail provider selection ───────────────────────────────────────
  MAIL_PROVIDER: z.enum(['smtp', 'ses']).default('smtp'),

  // ── Development SMTP (Nodemailer + Mailhog) ───────────────────────
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  // ── Staging (Resend) ──────────────────────────────────────────────
  RESEND_API_KEY: z.string().optional(),

  // ── Production (AWS SES) ──────────────────────────────────────────
  SES_FROM_ADDRESS: z.string().default('noreply@useherald.xyz'),
  SES_REGION: z.string().default('us-east-1'),
  SES_CONFIGURATION_SET: z.string().optional(),
  SES_AUTO_VERIFY_IDENTITIES: z.coerce.boolean().default(false),

  // ── SendGrid fallback ─────────────────────────────────────────────
  SENDGRID_API_KEY: z.string().optional(),

  // ── DKIM ──────────────────────────────────────────────────────────
  DKIM_DOMAIN: z.string().default('useherald.xyz'),
  DKIM_KEY_SELECTOR: z.string().default('herald2026'),

  // ── Arweave / Irys ────────────────────────────────────────────────
  IRYS_NODE: z.string().default('https://node1.irys.xyz'),
  IRYS_TOKEN: z.string().optional(),
  IRYS_NETWORK: z.enum(['mainnet', 'devnet']).default('devnet'),

  // ── Herald Auth & KMS ─────────────────────────────────────────────
  HERALD_AUTHORITY_KMS_KEY_ID: z.string().optional(),
  HERALD_AUTHORITY_SECRET_CIPHERTEXT: z.string().optional(),
  HERALD_X25519_PRIV_HEX: z.string().optional(),
  HERALD_X25519_PRIV_CIPHERTEXT: z.string().optional(),
  HERALD_MERKLE_TREE_ADDRESS: z.string().optional(),
  DEV_AUTHORITY_KEYPAIR_PATH: z.string().optional(),

  // ── Helio Billing ───────────────────────────────────────────────────
  HELIO_API_KEY: z.string().optional(),
  HELIO_SECRET_KEY: z.string().optional(),
  HELIO_WEBHOOK_SECRET: z.string().min(32).optional(),
  HELIO_TEMPLATE_GROWTH: z.string().optional(),
  HELIO_TEMPLATE_SCALE: z.string().optional(),
  HELIO_TEMPLATE_ENTERPRISE: z.string().optional(),
  HELIO_TEMPLATE_OVERCHARGE: z.string().optional(),
  HELIO_CHECKOUT_SUCCESS_URL: z
    .string()
    .url()
    .default('https://app.useherald.xyz/billing/success'),
  HELIO_CHECKOUT_CANCEL_URL: z
    .string()
    .url()
    .default('https://app.useherald.xyz/billing'),

  // ── Light Protocol (ZK Compression Receipts) ────────────────────
  LIGHT_RPC_URL: z.string().optional(),
  LIGHT_OUTPUT_TREE: z.string().optional(),
  HERALD_AUTHORITY_SECRET: z.string().optional(),
  RECEIPT_BATCH_SIZE: z.coerce.number().default(20),

  // ── Webhooks ──────────────────────────────────────────────────────
  WEBHOOK_SIGNING_SECRET: z
    .string()
    .min(16)
    .default('development-webhook-secret-32chars!!'),
  WEBHOOK_MAX_RETRIES: z.coerce.number().default(3),
  WEBHOOK_AUTO_DISABLE_THRESHOLD: z.coerce.number().default(10),
  ALLOW_LOCAL_WEBHOOKS: z.coerce.boolean().default(false),

  // ── Unsubscribe ───────────────────────────────────────────────────
  UNSUBSCRIBE_BASE_URL: z.string().default('https://notify.useherald.xyz'),
  UNSUBSCRIBE_JWT_SECRET: z
    .string()
    .min(16)
    .default('development-unsub-jwt-secret-32!!'),

  // ── Internal Service Auth ────────────────────────────────────────
  INTERNAL_API_KEY: z.string().min(32).optional(),

  // ── Monitoring ────────────────────────────────────────────────────
  PINO_LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error'])
    .default('info'),
  OTEL_EXPORTER_URL: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
});

export type GatewayConfig = z.infer<typeof EnvironmentSchema>;
