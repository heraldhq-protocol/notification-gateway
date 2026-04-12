/**
 * Tier limits for Herald protocol plans.
 * Shared across rate limiting, quota enforcement, and template access control.
 */

export interface TierLimits {
  name: string;
  sendsPerMonth: number;
  reqPerSecond: number;
  burstLimit: number;
  maxBatchSize: number;
  maxBodyBytes: number;
  maxSubjectChars: number;
  webhooks: number;
  apiKeys: number;
  teamMembers: number;
  customTemplates: number;
  customDkim: boolean;
  analyticsRetentionDays: number;
  sandboxUnlimited: boolean;
}

export const TIER_LIMITS: Record<number, TierLimits> = {
  // Developer (tier 0) — Free forever
  0: {
    name: 'Developer',
    sendsPerMonth: 1_000,
    reqPerSecond: 2,
    burstLimit: 10,
    maxBatchSize: 10,
    maxBodyBytes: 10_000,
    maxSubjectChars: 150,
    webhooks: 1,
    apiKeys: 2,
    teamMembers: 1,
    customTemplates: 0,
    customDkim: false,
    analyticsRetentionDays: 7,
    sandboxUnlimited: true,
  },

  // Growth (tier 1) — $99/month USDC
  1: {
    name: 'Growth',
    sendsPerMonth: 50_000,
    reqPerSecond: 20,
    burstLimit: 100,
    maxBatchSize: 100,
    maxBodyBytes: 50_000,
    maxSubjectChars: 200,
    webhooks: 5,
    apiKeys: 5,
    teamMembers: 3,
    customTemplates: 3,
    customDkim: false,
    analyticsRetentionDays: 30,
    sandboxUnlimited: true,
  },

  // Scale (tier 2) — $299/month USDC
  2: {
    name: 'Scale',
    sendsPerMonth: 250_000,
    reqPerSecond: 100,
    burstLimit: 500,
    maxBatchSize: 100,
    maxBodyBytes: 100_000,
    maxSubjectChars: 250,
    webhooks: 20,
    apiKeys: 20,
    teamMembers: 10,
    customTemplates: 20,
    customDkim: true,
    analyticsRetentionDays: 90,
    sandboxUnlimited: true,
  },

  // Enterprise (tier 3) — $999/month USDC
  3: {
    name: 'Enterprise',
    sendsPerMonth: 1_000_000,
    reqPerSecond: 500,
    burstLimit: 2_000,
    maxBatchSize: 1_000,
    maxBodyBytes: 256_000,
    maxSubjectChars: 500,
    webhooks: 100,
    apiKeys: 100,
    teamMembers: 999,
    customTemplates: 999,
    customDkim: true,
    analyticsRetentionDays: 365,
    sandboxUnlimited: true,
  },
};

/** Overage pricing per notification in USDC micro-units (6 decimals). */
export const OVERAGE_PRICE_PER_NOTIFICATION: Record<number, bigint> = {
  0: 500n, // $0.0005
  1: 400n, // $0.0004
  2: 300n, // $0.0003
  3: 200n, // $0.0002
};

/** Get tier limits, defaulting to Developer (tier 0). */
export function getTierLimits(tier: number): TierLimits {
  return TIER_LIMITS[tier] ?? TIER_LIMITS[0];
}
