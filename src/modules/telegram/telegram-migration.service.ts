import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { Telegram } from 'telegraf';
import { PrismaService } from '../../database/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { RoutingService } from '../routing/routing.service';
import { EnclaveService } from '../routing/enclave.service';
import { decryptAes256Gcm } from '../../common/utils/crypto.util';

// Redis TTLs
const MIGRATED_TTL = 30 * 24 * 60 * 60;   // 30 days — user has started the custom bot
const PROMPTED_TTL = 3 * 24 * 60 * 60;    // 3 days  — rate-limit re-prompting

// Max subscribers to fan-out prompts to per batch
const BATCH_SIZE = 10;

@Injectable()
export class TelegramMigrationService {
  private readonly logger = new Logger(TelegramMigrationService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly routing: RoutingService,
    private readonly enclave: EnclaveService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  // ── Migration state ───────────────────────────────────────────────────────

  /** Mark that a user has started the custom bot (i.e. they're migrated). */
  async markMigrated(chatId: string, protocolId: string): Promise<void> {
    await this.redis
      .setex(`tg:migrated:${chatId}:${protocolId}`, MIGRATED_TTL, '1')
      .catch(() => undefined);
  }

  /** Check whether a user has started the custom bot for this protocol. */
  async isMigrated(chatId: string, protocolId: string): Promise<boolean> {
    const val = await this.redis
      .get(`tg:migrated:${chatId}:${protocolId}`)
      .catch(() => null);
    return val !== null;
  }

  private async hasBeenPrompted(
    chatId: string,
    protocolId: string,
  ): Promise<boolean> {
    const val = await this.redis
      .get(`tg:migrate_prompt:${chatId}:${protocolId}`)
      .catch(() => null);
    return val !== null;
  }

  private async markPrompted(
    chatId: string,
    protocolId: string,
  ): Promise<void> {
    await this.redis
      .setex(`tg:migrate_prompt:${chatId}:${protocolId}`, PROMPTED_TTL, '1')
      .catch(() => undefined);
  }

  // ── Prompt delivery ───────────────────────────────────────────────────────

  /**
   * Send a migration prompt for a single chat via Herald's own bot.
   * Rate-limited to once per 3 days per (chat, protocol) pair.
   */
  async sendSinglePrompt(
    chatId: string,
    protocolId: string,
    customBotUsername: string,
    protocolName: string,
  ): Promise<void> {
    if (await this.hasBeenPrompted(chatId, protocolId)) return;

    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;

    const tg = new Telegram(token);
    const text =
      `📣 <b>${this.escapeHtml(protocolName)}</b> now sends notifications via ` +
      `<b>@${this.escapeHtml(customBotUsername)}</b>.\n\n` +
      `Tap the button below to receive their alerts directly from their bot.`;

    try {
      await tg.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `▶️ Start @${customBotUsername}`,
                url: `https://t.me/${customBotUsername}?start=hrld_${protocolId}`,
              },
            ],
          ],
        },
      } as any);
      await this.markPrompted(chatId, protocolId);
    } catch (err: any) {
      // 403 = user blocked Herald bot — skip silently
      if (err?.code !== 403) {
        this.logger.warn(
          `Migration prompt failed for chat ${chatId}: ${err.message}`,
        );
      }
    }
  }

  /**
   * Send a confirmation message via the protocol's custom bot after the user taps Start.
   * Fetches the encrypted token from DB, decrypts, and sends as the custom bot.
   */
  async sendCustomBotWelcome(chatId: string, protocolId: string): Promise<void> {
    const encKey = this.config.get<string>('ENCRYPTION_KEY_ID');
    if (!encKey) return;

    const settings = await this.prisma.protocolSettings.findUnique({
      where: { protocolId },
      select: {
        telegramBotTokenEncrypted: true,
        telegramBotUsername: true,
        protocol: { select: { nameEncrypted: true } },
      },
    });

    if (!settings?.telegramBotTokenEncrypted) return;

    let customBotToken: string;
    try {
      customBotToken = decryptAes256Gcm(settings.telegramBotTokenEncrypted, encKey);
    } catch {
      return;
    }

    const protocolName = await this.resolveProtocolName(protocolId);
    const tg = new Telegram(customBotToken);

    await tg
      .sendMessage(
        chatId,
        `✅ <b>You're connected!</b>\n\n` +
          `<b>${this.escapeHtml(protocolName)}</b> alerts will now be delivered directly via this bot.\n\n` +
          `You'll receive notifications for DeFi positions, governance votes, security alerts, and more.`,
        { parse_mode: 'HTML' } as any,
      )
      .catch((err: Error) => {
        this.logger.warn(`Custom bot welcome failed for chat ${chatId}: ${err.message}`);
      });
  }

  // ── Fan-out ───────────────────────────────────────────────────────────────

  /**
   * Fan out migration prompts to all active Telegram subscribers of a protocol.
   * Called once when a protocol first saves a custom bot token.
   * Batches in groups of 10 with a short delay to stay within Telegram rate limits.
   */
  async sendMigrationPrompts(protocolId: string): Promise<{
    sent: number;
    skipped: number;
  }> {
    const settings = await this.prisma.protocolSettings.findUnique({
      where: { protocolId },
      select: {
        telegramBotUsername: true,
        protocol: { select: { nameEncrypted: true } },
      },
    });

    const customBotUsername = settings?.telegramBotUsername;
    if (!customBotUsername) {
      this.logger.warn(
        `sendMigrationPrompts: no custom bot username for protocol ${protocolId}`,
      );
      return { sent: 0, skipped: 0 };
    }

    // Resolve protocol display name (nameEncrypted is AES — decrypt or fallback)
    const protocolName = await this.resolveProtocolName(protocolId);

    // All active subscribers with a wallet pubkey
    const subscriptions = await this.prisma.protocolSubscription.findMany({
      where: { protocolId, status: 'active', walletPubkey: { not: null } },
      select: { walletPubkey: true },
    });

    let sent = 0;
    let skipped = 0;

    for (let i = 0; i < subscriptions.length; i += BATCH_SIZE) {
      const batch = subscriptions.slice(i, i + BATCH_SIZE);

      await Promise.allSettled(
        batch.map(async ({ walletPubkey }) => {
          if (!walletPubkey) return;
          try {
            const identity = await this.routing.resolveIdentity(walletPubkey);
            if (!identity || !identity.channelTelegram) {
              skipped++;
              return;
            }
            const channels = await this.enclave.decryptAllChannels(identity);
            if (!channels.telegramChatId) {
              skipped++;
              return;
            }
            const chatId = channels.telegramChatId;
            if (await this.isMigrated(chatId, protocolId)) {
              skipped++;
              return;
            }
            await this.sendSinglePrompt(
              chatId,
              protocolId,
              customBotUsername,
              protocolName,
            );
            sent++;
          } catch {
            skipped++;
          }
        }),
      );

      // 500 ms between batches to stay within Telegram's 30 msg/sec global limit
      if (i + BATCH_SIZE < subscriptions.length) {
        await new Promise<void>((r) => setTimeout(r, 500));
      }
    }

    // Stamp when migration prompts were last sent
    await this.prisma.protocolSettings
      .update({
        where: { protocolId },
        data: { telegramMigrationSentAt: new Date() },
      })
      .catch(() => undefined);

    this.logger.log(
      `Migration fan-out for ${protocolId}: sent=${sent} skipped=${skipped}`,
    );
    return { sent, skipped };
  }

  /**
   * Clear all migration Redis keys for a protocol (called on custom bot removal).
   * Uses SCAN to avoid blocking Redis.
   */
  async clearMigrationState(protocolId: string): Promise<void> {
    const patterns = [
      `tg:migrated:*:${protocolId}`,
      `tg:migrate_prompt:*:${protocolId}`,
    ];
    for (const pattern of patterns) {
      let cursor = '0';
      do {
        const scanResult = await this.redis
          .scan(cursor, 'MATCH', pattern, 'COUNT', 100)
          .catch((): [string, string[]] => ['0', []]);
        cursor = scanResult[0];
        const keys = scanResult[1];
        if (keys.length > 0) {
          await this.redis.del(...keys).catch(() => undefined);
        }
      } while (cursor !== '0');
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async resolveProtocolName(protocolId: string): Promise<string> {
    try {
      const encKey = this.config.get<string>('ENCRYPTION_KEY_ID');
      if (!encKey) return 'Herald Protocol';
      const protocol = await this.prisma.protocol.findUnique({
        where: { id: protocolId },
        select: { nameEncrypted: true },
      });
      if (!protocol?.nameEncrypted) return 'Herald Protocol';
      return decryptAes256Gcm(protocol.nameEncrypted, encKey);
    } catch {
      return 'Herald Protocol';
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
