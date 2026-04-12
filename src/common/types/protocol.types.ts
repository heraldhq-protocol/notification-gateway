/**
 * Authenticated protocol context attached to every request
 * after passing through the AuthGuard.
 */
export interface AuthenticatedProtocol {
  protocolId: string;
  protocolPubkey: string;
  tier: number;
  scopes: string[];
  environment: string; // 'production' | 'sandbox'
  isActive: boolean;
  sendsThisPeriod?: bigint;
  name?: string;
}

/** Generated API key returned once at creation time. */
export interface GeneratedApiKey {
  plainText: string;
  hash: string;
  prefix: string;
}

/** Tier limits per protocol tier (legacy — use TierLimits from rate-limit.constants). */
export interface TierLimit {
  perSecond: number;
  burst: number;
  monthly: number;
}

/** Rate limit check result. */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/** Sandbox test contact addresses stored in protocol_settings. */
export interface SandboxTestContact {
  email?: string;
  telegramChatId?: string;
  phone?: string;
}
