import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Redis } from 'ioredis';
import { Telegram } from 'telegraf';
import { PrismaService } from '../../database/prisma.service';
import { REDIS_CLIENT } from '../redis/redis.module';
import { TelegramService } from '../channel/providers/telegram.provider';
import { decryptAes256Gcm } from '../../common/utils/crypto.util';

const START_PATTERN = /^\/start\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/;

const CATEGORY_EMOJI: Record<string, string> = {
  defi: '💰',
  governance: '🗳️',
  system: '⚙️',
  marketing: '📢',
};
const VALID_CATEGORIES = Object.keys(CATEGORY_EMOJI);
const MUTE_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

@Injectable()
export class TelegramWebhookService implements OnModuleInit {
  private readonly logger = new Logger(TelegramWebhookService.name);
  private telegram: Telegram | null = null;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly telegramService: TelegramService,
  ) {}

  onModuleInit(): void {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;

    try {
      // The gateway only SENDS notifications — it never registers a webhook.
      // The admin-api bot owns the single webhook for the shared bot token
      // and handles all incoming updates (commands, mute callbacks, /start).
      this.telegram = new Telegram(token);
      this.enabled = true;
      this.logger.log('Telegram send-only service initialized (Telegraf)');
    } catch (err) {
      this.logger.error('Failed to init Telegram service', {
        error: (err as Error).message,
      });
    }
  }

  // ── Secret token verification (used by controller) ────────────────────────

  verifySecret(incomingSecret?: string): boolean {
    const expected = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET', '');
    if (!expected) return true; // Not configured → allow (dev mode)
    return incomingSecret === expected;
  }

  // ── Bot-block management ──────────────────────────────────────────────────

  /**
   * Clear cached bot-block markers. A `tg:blocked:<chatId>` key is set for 7
   * days whenever Telegram returns 403 for a chat (user blocked the bot, or
   * the bot was misconfigured). After fixing the underlying cause (e.g. a bot
   * token mismatch), these stale markers must be cleared or delivery keeps
   * bailing early.
   *
   * @param chatId  Clear only this chat's marker; omit to clear all.
   * @returns the number of markers removed.
   */
  async clearBlockedChats(chatId?: string): Promise<number> {
    if (chatId) {
      return this.redis.del(`tg:blocked:${chatId}`);
    }

    // Scan + delete all tg:blocked:* keys (SCAN avoids blocking Redis on KEYS).
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        'tg:blocked:*',
        'COUNT',
        100,
      );
      cursor = next;
      if (keys.length > 0) {
        removed += await this.redis.del(...keys);
      }
    } while (cursor !== '0');

    return removed;
  }

  // ── Incoming update dispatcher ────────────────────────────────────────────

  async handleUpdate(update: Record<string, any>): Promise<void> {
    if (!this.enabled) return;

    // Handle inline button taps
    if (update?.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const message = update?.message;
    if (!message?.text) return;

    const chatId = String(message.chat?.id);
    const username: string | undefined = message.from?.username;
    const text: string = message.text.trim();

    // /start <walletPubkey> connect flow
    const startMatch = START_PATTERN.exec(text);
    if (startMatch) {
      await this.handleStartConnect(chatId, startMatch[1], username);
      return;
    }

    const command = text.split(' ')[0].toLowerCase();

    switch (command) {
      case '/start':
        await this.sendWelcome(chatId);
        break;
      case '/mute':
        await this.handleMuteCommand(chatId, text.split(' ')[1]?.trim());
        break;
      case '/unmute':
        await this.handleUnmuteCommand(chatId, text.split(' ')[1]?.trim());
        break;
      case '/categories':
        await this.handleCategoriesCommand(chatId);
        break;
    }
  }

  // ── Callback queries (inline button taps) ────────────────────────────────

  private async handleCallbackQuery(query: Record<string, any>): Promise<void> {
    const chatId = String(query?.message?.chat?.id ?? query?.chat?.id ?? '');
    const callbackData: string = query?.data ?? '';
    const queryId: string = query?.id ?? '';

    try {
      if (callbackData.startsWith('mute_')) {
        const notifId = callbackData.slice(5);
        await this.handleMuteCallback(chatId, notifId, queryId);
        return;
      }
    } catch (err) {
      this.logger.warn(`Callback query error: ${(err as Error).message}`);
    }

    // Acknowledge any unhandled callback to clear the spinner
    if (this.telegram && queryId) {
      await this.telegram.answerCbQuery(queryId).catch(() => undefined);
    }
  }

  private async handleMuteCallback(
    chatId: string,
    notifId: string,
    queryId: string,
  ): Promise<void> {
    const notif = await this.prisma.notification.findUnique({
      where: { id: notifId },
      select: { protocolId: true },
    });

    if (!notif) {
      await this.telegram
        ?.answerCbQuery(queryId, '⚠️ Notification not found.')
        .catch(() => undefined);
      return;
    }

    const muteKey = `tg:mute:${chatId}:${notif.protocolId}`;
    await this.redis.setex(muteKey, MUTE_TTL_SECONDS, '1');

    this.logger.log(`Muted: chat=${chatId} protocol=${notif.protocolId}`);

    await this.telegram
      ?.answerCbQuery(
        queryId,
        "🔇 Muted. You won't receive Telegram notifications from this protocol.",
      )
      .catch(() => undefined);
  }

  // ── /start connect flow ───────────────────────────────────────────────────

  private async handleStartConnect(
    chatId: string,
    walletPubkey: string,
    username?: string,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await this.prisma.telegramPendingConnection.deleteMany({
      where: { walletPubkey, claimed: false },
    });

    await this.prisma.telegramPendingConnection.create({
      data: {
        walletPubkey,
        chatId,
        telegramUsername: username ?? null,
        claimed: false,
        expiresAt,
      },
    });

    this.logger.log(
      `Telegram connect initiated — wallet=${walletPubkey} chat=${chatId}`,
    );

    if (this.telegram) {
      await this.telegram
        .sendMessage(
          chatId,
          '✅ <b>Almost there!</b>\n\nReturn to the Herald portal to complete the connection. This link expires in 10 minutes.',
          { parse_mode: 'HTML' },
        )
        .catch((err: Error) => {
          this.logger.warn(
            `Could not send confirmation to ${chatId}: ${err.message}`,
          );
        });
    }
  }

  private async sendWelcome(chatId: string): Promise<void> {
    if (!this.telegram) return;
    await this.telegram
      .sendMessage(
        chatId,
        '👋 <b>Welcome to Herald!</b>\n\nTo connect your Telegram account, go to the Herald developer portal and click <b>Connect Telegram</b>.\n\n<b>Commands:</b>\n/mute &lt;category&gt; — mute a category\n/unmute &lt;category&gt; — unmute a category\n/categories — show all categories',
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  }

  // ── Per-category mute commands ────────────────────────────────────────────

  private async handleMuteCommand(
    chatId: string,
    category?: string,
  ): Promise<void> {
    if (!this.telegram) return;

    if (!category) {
      await this.telegram
        .sendMessage(
          chatId,
          `Usage: /mute &lt;category&gt;\n\nAvailable categories: ${VALID_CATEGORIES.join(', ')}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
      return;
    }

    const cat = category.toLowerCase();
    if (!VALID_CATEGORIES.includes(cat)) {
      await this.telegram
        .sendMessage(
          chatId,
          `❌ Unknown category <b>${this.escapeHtml(cat)}</b>.\n\nValid categories: ${VALID_CATEGORIES.join(', ')}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
      return;
    }

    const muteKey = `tg:mute_cat:${chatId}:${cat}`;
    await this.redis.setex(muteKey, MUTE_TTL_SECONDS, '1');

    const emoji = CATEGORY_EMOJI[cat] ?? '🔔';
    await this.telegram
      .sendMessage(
        chatId,
        `🔇 ${emoji} <b>${cat}</b> notifications muted for 30 days.\n\nUse /unmute ${cat} to re-enable.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  }

  private async handleUnmuteCommand(
    chatId: string,
    category?: string,
  ): Promise<void> {
    if (!this.telegram) return;

    if (!category) {
      await this.telegram
        .sendMessage(
          chatId,
          `Usage: /unmute &lt;category&gt;\n\nAvailable categories: ${VALID_CATEGORIES.join(', ')}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
      return;
    }

    const cat = category.toLowerCase();
    if (!VALID_CATEGORIES.includes(cat)) {
      await this.telegram
        .sendMessage(
          chatId,
          `❌ Unknown category <b>${this.escapeHtml(cat)}</b>.`,
          { parse_mode: 'HTML' },
        )
        .catch(() => undefined);
      return;
    }

    const muteKey = `tg:mute_cat:${chatId}:${cat}`;
    await this.redis.del(muteKey);

    const emoji = CATEGORY_EMOJI[cat] ?? '🔔';
    await this.telegram
      .sendMessage(
        chatId,
        `🔔 ${emoji} <b>${cat}</b> notifications re-enabled.`,
        { parse_mode: 'HTML' },
      )
      .catch(() => undefined);
  }

  private async handleCategoriesCommand(chatId: string): Promise<void> {
    if (!this.telegram) return;

    const lines: string[] = ['<b>Notification categories:</b>\n'];
    for (const [cat, emoji] of Object.entries(CATEGORY_EMOJI)) {
      const muteKey = `tg:mute_cat:${chatId}:${cat}`;
      const muted = await this.redis.get(muteKey).catch(() => null);
      lines.push(
        `${emoji} <b>${cat}</b> — ${muted ? '🔇 muted' : '✅ active'}`,
      );
    }
    lines.push(
      '\nUse /mute &lt;category&gt; or /unmute &lt;category&gt; to change.',
    );

    await this.telegram
      .sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' })
      .catch(() => undefined);
  }

  // ── Public helpers (used by channel-dispatch) ─────────────────────────────

  async isChatMutedForProtocol(
    chatId: string,
    protocolId: string,
  ): Promise<boolean> {
    const muteKey = `tg:mute:${chatId}:${protocolId}`;
    const val = await this.redis.get(muteKey).catch(() => null);
    return val !== null;
  }

  async isCategoryMutedForChat(
    chatId: string,
    category: string,
  ): Promise<boolean> {
    const muteKey = `tg:mute_cat:${chatId}:${category}`;
    const val = await this.redis.get(muteKey).catch(() => null);
    return val !== null;
  }

  async wasGroupNotified(
    notificationId: string,
    groupChatId: string,
  ): Promise<boolean> {
    const key = `tg:group_sent:${notificationId}:${groupChatId}`;
    const val = await this.redis.get(key).catch(() => null);
    return val !== null;
  }

  async markGroupNotified(
    notificationId: string,
    groupChatId: string,
  ): Promise<void> {
    const key = `tg:group_sent:${notificationId}:${groupChatId}`;
    await this.redis.setex(key, 86400, '1').catch(() => undefined);
  }

  // ── Engagement tracking ───────────────────────────────────────────────────

  async recordClickAsync(notifId: string): Promise<void> {
    try {
      const notif = await this.prisma.notification.findUnique({
        where: { id: notifId },
        select: { protocolId: true },
      });
      if (!notif) return;

      await this.prisma.notificationEngagement.create({
        data: {
          notificationId: notifId,
          protocolId: notif.protocolId,
          eventType: 'tg_click',
        },
      });
    } catch (err) {
      this.logger.debug(
        `Failed to record Telegram click for ${notifId}: ${(err as Error).message}`,
      );
    }
  }

  // ── Cron: clean expired pending connections ───────────────────────────────

  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanExpiredPendingConnections(): Promise<void> {
    const { count } = await this.prisma.telegramPendingConnection.deleteMany({
      where: {
        OR: [{ expiresAt: { lt: new Date() } }, { claimed: true }],
      },
    });
    if (count > 0) {
      this.logger.debug(
        `Cleaned ${count} expired/claimed Telegram pending connections`,
      );
    }
  }

  // ── Cron: refresh group member counts (daily) ─────────────────────────────

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshGroupMemberCounts(): Promise<void> {
    const settingsRows = await this.prisma.protocolSettings.findMany({
      where: { telegramGroupChatId: { not: null } },
      select: {
        protocolId: true,
        telegramGroupChatId: true,
        telegramBotTokenEncrypted: true,
      },
    });
    if (settingsRows.length === 0) return;

    const encKey = this.config.get<string>('ENCRYPTION_KEY_ID');
    let updated = 0;

    for (const row of settingsRows) {
      if (!row.telegramGroupChatId) continue;
      let customBotToken: string | undefined;
      if (row.telegramBotTokenEncrypted && encKey) {
        try {
          customBotToken = decryptAes256Gcm(
            row.telegramBotTokenEncrypted,
            encKey,
          );
        } catch {
          /* fall back to Herald bot */
        }
      }

      const count = await this.telegramService.getGroupMemberCount(
        row.telegramGroupChatId,
        customBotToken,
      );
      if (count !== null) {
        await this.prisma.protocolSettings
          .update({
            where: { protocolId: row.protocolId },
            data: {
              telegramGroupMemberCount: count,
              telegramMemberCountAt: new Date(),
            },
          })
          .catch(() => undefined);
        updated++;
      }
    }

    if (updated > 0) {
      this.logger.log(
        `Refreshed Telegram member counts for ${updated} group(s)`,
      );
    }
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}
