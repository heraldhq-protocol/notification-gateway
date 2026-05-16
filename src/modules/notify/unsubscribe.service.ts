import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

/**
 * Decoded unsubscribe token payload.
 */
export interface UnsubscribePayload {
  walletHash: string;
  category: string | null; // null = unsubscribe from ALL
  protocolId?: string;
  expiresAt: number; // Unix timestamp (seconds)
}

/**
 * UnsubscribeService — generates and validates HMAC-signed unsubscribe tokens.
 *
 * Token format: base64url({ walletHash, category, protocolId, exp }).signature
 *
 * Supports:
 *   - Per-category opt-out (e.g. stop governance notifications)
 *   - Full opt-out (all notifications) when category is null/'all'
 *   - 7-day expiry (matching the unsubscribe_tokens table default)
 *   - One-click List-Unsubscribe-Post (RFC 8058)
 */
@Injectable()
export class UnsubscribeService {
  private readonly logger = new Logger(UnsubscribeService.name);
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly tokenTtlSeconds = 7 * 24 * 60 * 60; // 7 days

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.secret = this.config.get<string>(
      'UNSUBSCRIBE_JWT_SECRET',
      'development-unsub-jwt-secret-32!!',
    );
    this.baseUrl = this.config.get<string>(
      'UNSUBSCRIBE_BASE_URL',
      'https://notify.useherald.xyz',
    );
  }

  /**
   * Generate a signed unsubscribe URL for inclusion in emails.
   *
   * @param walletHash - SHA-256 hash of the wallet pubkey
   * @param category - Notification category to unsubscribe from, or null for all
   * @param protocolId - Optional protocol ID for scoped unsubscribe
   */
  generateUnsubscribeUrl(
    walletHash: string,
    category: string | null = null,
    protocolId?: string,
  ): string {
    const token = this.generateToken(walletHash, category, protocolId);
    return `${this.baseUrl}/unsubscribe/${token}`;
  }

  /**
   * Generate a signed token string.
   */
  generateToken(
    walletHash: string,
    category: string | null = null,
    protocolId?: string,
  ): string {
    const expiresAt = Math.floor(Date.now() / 1000) + this.tokenTtlSeconds;

    const payload: UnsubscribePayload = {
      walletHash,
      category,
      protocolId,
      expiresAt,
    };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString(
      'base64url',
    );
    const signature = this.sign(payloadStr);

    // Store the token hash in DB for tracking
    const tokenHash = createHmac('sha256', 'token-hash')
      .update(`${payloadStr}.${signature}`)
      .digest('hex');

    this.prisma.unsubscribeToken
      .create({
        data: {
          tokenHash,
          walletHash,
          category,
          expiresAt: new Date(expiresAt * 1000),
        },
      })
      .catch((err) => {
        this.logger.warn(
          `Failed to store unsubscribe token: ${(err as Error).message}`,
        );
      });

    return `${payloadStr}.${signature}`;
  }

  /**
   * Validate a token and execute the unsubscribe action.
   *
   * Returns the payload if valid, or null if invalid/expired.
   */
  async validateAndExecute(token: string): Promise<{
    success: boolean;
    payload?: UnsubscribePayload;
    error?: string;
  }> {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { success: false, error: 'Invalid token format' };
    }

    const [payloadStr, signature] = parts;

    // Verify HMAC signature
    const expectedSig = this.sign(payloadStr);
    const sigBuffer = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expectedSig, 'base64url');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return { success: false, error: 'Invalid signature' };
    }

    // Decode payload
    let payload: UnsubscribePayload;
    try {
      payload = JSON.parse(
        Buffer.from(payloadStr, 'base64url').toString('utf-8'),
      );
    } catch {
      return { success: false, error: 'Invalid payload' };
    }

    // Check expiry
    if (payload.expiresAt < Math.floor(Date.now() / 1000)) {
      return { success: false, error: 'Token expired' };
    }

    // Check if token was already used
    const tokenHash = createHmac('sha256', 'token-hash')
      .update(token)
      .digest('hex');

    const existingToken = await this.prisma.unsubscribeToken.findUnique({
      where: { tokenHash },
    });

    if (existingToken?.usedAt) {
      return { success: false, error: 'Token already used' };
    }

    // Execute the unsubscribe
    await this.executeUnsubscribe(payload);

    // Mark token as used
    if (existingToken) {
      await this.prisma.unsubscribeToken.update({
        where: { tokenHash },
        data: { usedAt: new Date() },
      });
    }

    return { success: true, payload };
  }

  /**
   * Decode a token without executing (for confirmation page).
   */
  decodeToken(token: string): UnsubscribePayload | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    const [payloadStr, signature] = parts;
    const expectedSig = this.sign(payloadStr);
    const sigBuffer = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expectedSig, 'base64url');

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      return null;
    }

    try {
      const payload: UnsubscribePayload = JSON.parse(
        Buffer.from(payloadStr, 'base64url').toString('utf-8'),
      );
      if (payload.expiresAt < Math.floor(Date.now() / 1000)) return null;
      return payload;
    } catch {
      return null;
    }
  }

  // ── Private ──────────────────────────────────────────────────────────

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  /**
   * Execute the actual opt-out by updating portal_users opt-in flags.
   *
   * Supports:
   *   - Per-category: sets the specific opt_in_* flag to false
   *   - Full opt-out: sets opt_in_all to false (disables everything)
   */
  private async executeUnsubscribe(payload: UnsubscribePayload): Promise<void> {
    const { walletHash, category } = payload;

    // Check if user exists
    const user = await this.prisma.portalUser.findUnique({
      where: { walletHash },
    });

    if (!user) {
      this.logger.warn(
        `Unsubscribe: portal user not found for wallet hash ${walletHash.slice(0, 8)}...`,
      );
      return;
    }

    if (!category || category === 'all') {
      // Full opt-out — disable all notifications
      await this.prisma.portalUser.update({
        where: { walletHash },
        data: {
          optInAll: false,
          updatedAt: new Date(),
        },
      });
      this.logger.log(
        `Unsubscribed wallet ${walletHash.slice(0, 8)}... from ALL notifications`,
      );
    } else {
      // Per-category opt-out
      const updateData: Record<string, any> = { updatedAt: new Date() };

      switch (category) {
        case 'defi':
          updateData.optInDefi = false;
          break;
        case 'governance':
          updateData.optInGovernance = false;
          break;
        case 'marketing':
          updateData.optInMarketing = false;
          break;
        default:
          this.logger.warn(`Unknown unsubscribe category: ${category}`);
          return;
      }

      await this.prisma.portalUser.update({
        where: { walletHash },
        data: updateData,
      });
      this.logger.log(
        `Unsubscribed wallet ${walletHash.slice(0, 8)}... from '${category}' notifications`,
      );
    }
  }
}
