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

  // ── Custom Bot Webhook Processing ──────────────────────────────────────────

  async getCustomBotToken(protocolId: string): Promise<string | null> {
    const encKey = this.config.get<string>('ENCRYPTION_KEY_ID');
    if (!encKey) return null;

    const settings = await this.prisma.protocolSettings.findUnique({
      where: { protocolId },
      select: { telegramBotTokenEncrypted: true },
    });

    if (!settings?.telegramBotTokenEncrypted) return null;

    try {
      return decryptAes256Gcm(settings.telegramBotTokenEncrypted, encKey);
    } catch {
      return null;
    }
  }

  async checkIsAdmin(tg: Telegram, chatId: string, userId: number): Promise<boolean> {
    try {
      const member = await tg.getChatMember(chatId, userId);
      return ['creator', 'administrator'].includes(member.status);
    } catch {
      return false;
    }
  }

  async handleCustomBotUpdate(
    protocolId: string,
    update: Record<string, any>,
  ): Promise<void> {
    const token = await this.getCustomBotToken(protocolId);
    if (!token) {
      this.logger.warn(`No custom bot token found for protocol ${protocolId}`);
      return;
    }

    const tg = new Telegram(token);

    // 1. Callback Queries (inline button taps)
    if (update?.callback_query) {
      await this.handleCustomBotCallbackQuery(tg, protocolId, update.callback_query);
      return;
    }

    // 2. Messages
    const message = update?.message;
    if (message) {
      const chatId = String(message.chat?.id);
      const userId = message.from?.id;

      // 2a. New Chat Members (welcome greeting)
      if (message.new_chat_members && Array.isArray(message.new_chat_members)) {
        await this.handleCustomBotNewChatMembers(tg, protocolId, chatId, message.new_chat_members);
        return;
      }

      // 2b. Commands & Texts
      if (message.text) {
        await this.handleCustomBotMessageText(tg, protocolId, chatId, userId, message.text.trim(), message.chat?.type);
        return;
      }
    }

    // 3. My Chat Member Updates (bot added/removed from group)
    if (update?.my_chat_member) {
      await this.handleCustomBotMyChatMember(tg, protocolId, update.my_chat_member);
      return;
    }

    // 4. Reactions on custom bot notifications
    if (update?.message_reaction) {
      await this.handleCustomBotMessageReaction(protocolId, update.message_reaction);
      return;
    }
  }

  private async handleCustomBotCallbackQuery(
    tg: Telegram,
    protocolId: string,
    query: Record<string, any>,
  ): Promise<void> {
    const chatId = String(query?.message?.chat?.id ?? query?.chat?.id ?? '');
    const callbackData: string = query?.data ?? '';
    const queryId: string = query?.id ?? '';

    try {
      if (callbackData.startsWith('mute_')) {
        const notifId = callbackData.slice(5);
        const notif = await this.prisma.notification.findUnique({
          where: { id: notifId },
          select: { protocolId: true },
        });

        if (notif?.protocolId) {
          const muteKey = `tg:mute:${chatId}:${notif.protocolId}`;
          await this.redis.setex(muteKey, 30 * 24 * 60 * 60, '1');
          await tg.answerCbQuery(
            queryId,
            { text: "🔇 Muted. You won't receive Telegram notifications from this protocol." } as any,
          ).catch(() => undefined);
        } else {
          await tg.answerCbQuery(queryId, { text: '⚠️ Notification not found.' } as any).catch(() => undefined);
        }
        return;
      }
    } catch (err) {
      this.logger.warn(`Callback query error: ${(err as Error).message}`);
    }

    if (queryId) {
      await tg.answerCbQuery(queryId).catch(() => undefined);
    }
  }

  private async handleCustomBotNewChatMembers(
    tg: Telegram,
    protocolId: string,
    chatId: string,
    newChatMembers: any[],
  ): Promise<void> {
    const settings = await this.prisma.protocolSettings.findUnique({
      where: { protocolId },
      select: { telegramWelcomeMessage: true, telegramGroupChatId: true },
    });

    const welcome = settings?.telegramWelcomeMessage;
    if (!welcome || settings?.telegramGroupChatId !== chatId) return;

    for (const member of newChatMembers) {
      if (member?.is_bot) continue;
      const name = member?.first_name ?? 'there';
      const safeName = name
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const text = welcome.replace(/\{\{name\}\}/g, safeName);
      await tg
        .sendMessage(chatId, text, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        } as any)
        .catch(() => undefined);
    }
  }

  private async handleCustomBotMyChatMember(
    tg: Telegram,
    protocolId: string,
    myChatMember: Record<string, any>,
  ): Promise<void> {
    const newStatus = myChatMember.new_chat_member?.status;
    const chatId = String(myChatMember.chat?.id ?? '');
    const senderId = myChatMember.from?.id;
    if (!chatId || !senderId) return;

    if (['left', 'kicked'].includes(newStatus)) {
      const settings = await this.prisma.protocolSettings.findUnique({
        where: { protocolId },
        select: { telegramGroupChatId: true },
      });

      if (settings?.telegramGroupChatId === chatId) {
        await this.prisma.protocolSettings.update({
          where: { protocolId },
          data: { telegramGroupChatId: null, telegramGroupMemberCount: null },
        });
        this.logger.warn(`Custom bot kicked from group ${chatId} — cleared settings for protocol ${protocolId}`);
      }
    } else if (['member', 'administrator'].includes(newStatus)) {
      const chatType = myChatMember.chat?.type;
      if (['group', 'supergroup'].includes(chatType)) {
        const isAdmin = await this.checkIsAdmin(tg, chatId, senderId);
        if (!isAdmin) {
          await (tg as any).leaveChat(chatId).catch(() => undefined);
          return;
        }

        // Do NOT auto-link the group here — require a portal-initiated nonce flow.
        // Auto-linking on join would let any group the bot is invited to silently
        // overwrite the configured delivery group.
        await tg.sendMessage(
          chatId,
          `👋 <b>Herald Bot added!</b>\n\n` +
            `To link this group for notifications, go to your Herald Dashboard → Settings → Telegram → Link Group and follow the setup flow.`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
      }
    }
  }

  private async handleCustomBotMessageReaction(
    protocolId: string,
    reaction: Record<string, any>,
  ): Promise<void> {
    const chatId = String(reaction?.chat?.id ?? '');
    const messageId = String(reaction?.message_id ?? '');
    if (!chatId || !messageId) return;

    const newReactions: any[] = reaction?.new_reaction ?? [];
    if (newReactions.length === 0) return;

    const notifId = await this.redis
      .get(`tg:gmsg:${chatId}:${messageId}`)
      .catch(() => null);
    if (!notifId) return;

    const notif = await this.prisma.notification.findUnique({
      where: { id: notifId },
      select: { protocolId: true },
    });
    if (!notif || notif.protocolId !== protocolId) return;

    const emoji = newReactions[0]?.emoji ?? newReactions[0]?.custom_emoji_id ?? 'unknown';

    await this.prisma.notificationEngagement
      .create({
        data: {
          notificationId: notifId,
          protocolId,
          eventType: 'tg_reaction',
          linkUrl: String(emoji),
        },
      })
      .catch(() => undefined);
  }

  private async handleCustomBotMessageText(
    tg: Telegram,
    protocolId: string,
    chatId: string,
    userId: number | undefined,
    text: string,
    chatType: string | undefined,
  ): Promise<void> {
    const isGroup = ['group', 'supergroup'].includes(chatType ?? '');

    const verifyGroupAdmin = async (): Promise<boolean> => {
      if (!isGroup) return true;
      if (!userId) return false;
      return this.checkIsAdmin(tg, chatId, userId);
    };

    const rawCmd = text.split(' ')[0];
    const cleanCmd = rawCmd.split('@')[0].toLowerCase();

    if (cleanCmd === '/start') {
      const arg = text.split(' ')[1]?.trim();
      if (arg && arg.startsWith('hrld_')) {
        await this.markMigrated(chatId, protocolId);
        this.logger.log(`Custom bot migration completed via command: chat=${chatId} protocol=${protocolId}`);
        await this.sendCustomBotWelcome(chatId, protocolId);
        return;
      }

      if (arg && arg.startsWith('setup_')) {
        const nonce = arg.slice(6);
        const senderId = userId;
        if (!senderId) return;

        const isAdmin = await this.checkIsAdmin(tg, chatId, senderId);
        if (!isAdmin) {
          await tg.sendMessage(chatId, '⚠️ Only group creators or administrators can link this bot.', { parse_mode: 'HTML' } as any).catch(() => undefined);
          return;
        }

        const redisKey = `tg:group_nonce:${nonce}`;
        const data = await this.redis.get(redisKey);
        if (!data) {
          await tg.sendMessage(chatId, '⏰ This setup link has expired. Please generate a new one from the Herald Portal.', { parse_mode: 'HTML' } as any).catch(() => undefined);
          return;
        }

        const parsed = JSON.parse(data);

        // Reject nonces generated for the shared Herald bot — those must be
        // completed by the shared bot, not a custom bot webhook.
        if (parsed.botType && parsed.botType !== 'custom') {
          await tg.sendMessage(chatId, '⚠️ This setup link is for a different bot. Please use the correct bot to complete group setup.', { parse_mode: 'HTML' } as any).catch(() => undefined);
          return;
        }

        // Link group
        await this.prisma.protocolSettings.update({
          where: { protocolId: parsed.protocolId },
          data: { telegramGroupChatId: chatId },
        });

        // Update nonce status in Redis
        parsed.status = 'completed';
        parsed.chatId = chatId;
        await this.redis.setex(redisKey, 60, JSON.stringify(parsed));

        this.logger.log(`Group chat ID securely linked via custom bot: chatId=${chatId} protocol=${parsed.protocolId}`);

        await tg.sendMessage(
          chatId,
          '✅ <b>Group Linked Successfully!</b>\n\n' +
            'This group chat is now linked to your Herald protocol dashboard.\n\n' +
            'Make sure this bot is promoted to <b>Administrator</b> with permission to post messages so alerts are delivered properly.',
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
        return;
      }

      if (!isGroup) {
        await tg.sendMessage(
          chatId,
          `👋 <b>Welcome!</b>\n\nI am the official custom notification bot for this protocol. I will deliver your real-time alerts here.\n\nUse /help to see available commands.`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
      }
      return;
    }

    if (cleanCmd === '/status') {
      if (!(await verifyGroupAdmin())) return;

      if (isGroup) {
        // Read-only: show whether this group is the configured delivery group.
        // Do not auto-link — use the portal nonce flow for that.
        const settings = await this.prisma.protocolSettings.findUnique({
          where: { protocolId },
          select: { telegramGroupChatId: true },
        });
        const isLinked = settings?.telegramGroupChatId === chatId;

        await tg.sendMessage(
          chatId,
          isLinked
            ? `📊 <b>Herald Bot Status</b>\n\n` +
              `✅ This group (<code>${chatId}</code>) is linked as the delivery group for this protocol.`
            : `📊 <b>Herald Bot Status</b>\n\n` +
              `⚠️ This group is <b>not yet linked</b> for notifications.\n\n` +
              `To link it, go to your Herald Dashboard → Settings → Telegram → Link Group.`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
      } else {
        await tg.sendMessage(
          chatId,
          `📊 <b>Herald Bot Status</b>\n\n` +
            `✅ Chat ID: <code>${chatId}</code>\n` +
            `✅ Connection: Active\n\n` +
            `You are securely linked to receive direct alerts from this bot.`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
      }
      return;
    }

    if (cleanCmd === '/help') {
      if (!(await verifyGroupAdmin())) return;

      await tg.sendMessage(
        chatId,
        `📖 <b>Available Commands</b>\n\n` +
          `/status — Check bot status and link group chat\n` +
          `/mute &lt;category&gt; — Mute a notification category\n` +
          `/unmute &lt;category&gt; — Unmute a notification category\n` +
          `/categories — Show all alert categories`,
        { parse_mode: 'HTML' } as any,
      ).catch(() => undefined);
      return;
    }

    if (cleanCmd === '/mute') {
      if (!(await verifyGroupAdmin())) return;

      const category = text.split(' ')[1]?.trim().toLowerCase();
      const validCategories = ['defi', 'governance', 'system', 'marketing'];
      if (!category) {
        await tg.sendMessage(
          chatId,
          `Usage: /mute &lt;category&gt;\n\nValid categories: ${validCategories.join(', ')}`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
        return;
      }

      if (!validCategories.includes(category)) {
        await tg.sendMessage(
          chatId,
          `❌ Unknown category <b>${this.escapeHtml(category)}</b>.\n\nValid categories: ${validCategories.join(', ')}`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
        return;
      }

      const muteKey = `tg:mute_cat:${chatId}:${category}`;
      await this.redis.setex(muteKey, 30 * 24 * 60 * 60, '1');

      const emojiMap: Record<string, string> = {
        defi: '💰', governance: '🗳️', system: '⚙️', marketing: '📢',
      };
      await tg.sendMessage(
        chatId,
        `🔇 ${emojiMap[category] ?? '🔔'} <b>${category}</b> notifications muted for 30 days.\n\nUse /unmute ${category} to re-enable.`,
        { parse_mode: 'HTML' } as any,
      ).catch(() => undefined);
      return;
    }

    if (cleanCmd === '/unmute') {
      if (!(await verifyGroupAdmin())) return;

      const category = text.split(' ')[1]?.trim().toLowerCase();
      const validCategories = ['defi', 'governance', 'system', 'marketing'];
      if (!category) {
        await tg.sendMessage(
          chatId,
          `Usage: /unmute &lt;category&gt;\n\nValid categories: ${validCategories.join(', ')}`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
        return;
      }

      if (!validCategories.includes(category)) {
        await tg.sendMessage(
          chatId,
          `❌ Unknown category <b>${this.escapeHtml(category)}</b>.`,
          { parse_mode: 'HTML' } as any,
        ).catch(() => undefined);
        return;
      }

      const muteKey = `tg:mute_cat:${chatId}:${category}`;
      await this.redis.del(muteKey);

      const emojiMap: Record<string, string> = {
        defi: '💰', governance: '🗳️', system: '⚙️', marketing: '📢',
      };
      await tg.sendMessage(
        chatId,
        `🔔 ${emojiMap[category] ?? '🔔'} <b>${category}</b> notifications re-enabled.`,
        { parse_mode: 'HTML' } as any,
      ).catch(() => undefined);
      return;
    }

    if (cleanCmd === '/categories') {
      if (!(await verifyGroupAdmin())) return;

      const emojiMap: Record<string, string> = {
        defi: '💰', governance: '🗳️', system: '⚙️', marketing: '📢',
      };
      const lines: string[] = ['<b>Notification categories:</b>\n'];
      for (const cat of ['defi', 'governance', 'system', 'marketing']) {
        const muteKey = `tg:mute_cat:${chatId}:${cat}`;
        const muted = await this.redis.get(muteKey).catch(() => null);
        lines.push(
          `${emojiMap[cat]} <b>${cat}</b> — ${muted ? '🔇 muted' : '✅ active'}`,
        );
      }
      lines.push('\nUse /mute &lt;category&gt; or /unmute &lt;category&gt; to change.');

      await tg.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' } as any).catch(() => undefined);
      return;
    }
  }
}

