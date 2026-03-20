import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';

/**
 * RpcManagerService — manages the active Solana RPC connection with
 * an optional circuit breaker for automatic failover.
 *
 * Config:
 *   SOLANA_RPC_URL          — Primary RPC endpoint (required)
 *   SOLANA_FALLBACK_RPC_URL — Fallback RPC endpoint (optional)
 *
 * Works with any Solana RPC provider: local validator, public endpoints,
 * Helius, QuickNode, Alchemy, etc.
 *
 * NF-008: If the primary fails 5+ times, switch to fallback.
 *         Attempt recovery back to primary every 30 seconds.
 */
@Injectable()
export class RpcManagerService {
  private activeConnection: Connection;
  private circuitBreakerOpen = false;
  private failureCount = 0;
  private lastFailureAt: Date | null = null;

  private readonly primaryUrl: string;
  private readonly fallbackUrl: string | undefined;
  private readonly logger = new Logger(RpcManagerService.name);

  constructor(private readonly config: ConfigService) {
    this.primaryUrl = this.config.getOrThrow<string>('SOLANA_RPC_URL');
    this.fallbackUrl = this.config.get<string>('SOLANA_FALLBACK_RPC_URL');

    this.activeConnection = new Connection(this.primaryUrl, {
      commitment: 'confirmed',
    });
  }

  /** Get the currently active Solana RPC connection. */
  getConnection(): Connection {
    if (!this.circuitBreakerOpen) return this.activeConnection;

    // Attempt recovery every 30s
    if (
      this.lastFailureAt &&
      Date.now() - this.lastFailureAt.getTime() > 30_000
    ) {
      this.logger.log('Circuit breaker: attempting recovery to primary RPC');
      this.circuitBreakerOpen = false;
      this.failureCount = 0;
      this.activeConnection = new Connection(this.primaryUrl, {
        commitment: 'confirmed',
      });
    }

    return this.activeConnection;
  }

  /** Record an RPC failure. After 5+ failures, switch to fallback (if configured). */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = new Date();

    if (this.failureCount > 5 && this.fallbackUrl) {
      this.logger.error('Circuit breaker OPEN: switching to fallback RPC');
      this.circuitBreakerOpen = true;
      this.activeConnection = new Connection(this.fallbackUrl, {
        commitment: 'confirmed',
      });
      this.failureCount = 0;
    }
  }

  /** Record a successful RPC call (decrements failure counter). */
  recordSuccess(): void {
    if (this.failureCount > 0) this.failureCount--;
  }
}
