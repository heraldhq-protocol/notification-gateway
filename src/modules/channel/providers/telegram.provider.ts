import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * TelegramService — sends notifications via the Telegram Bot API.
 *
 * Uses `node-telegram-bot-api` for message dispatch.
 * The bot token is configured via TELEGRAM_BOT_TOKEN env var.
 *
 * SEC-001: chat_id is received as a plaintext parameter, used only
 * for the sendMessage call, and NEVER logged or stored.
 */
@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: any; // TelegramBot instance (lazy-loaded)
  private enabled = false;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN not configured — Telegram channel disabled',
      );
      return;
    }

    try {
      // Dynamic import to avoid breaking if package isn't installed
      const TelegramBot = (await import('node-telegram-bot-api')).default;
      this.bot = new TelegramBot(token, { polling: false });
      this.enabled = true;
      this.logger.log('Telegram bot initialized');
    } catch (err) {
      this.logger.error('Failed to initialize Telegram bot', {
        error: (err as Error).message,
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send a notification message to a Telegram chat.
   *
   * @param params.chatId        - Telegram chat ID (decrypted, in-memory only)
   * @param params.protocolName  - Protocol display name
   * @param params.subject       - Notification subject
   * @param params.body          - Notification body
   * @param params.category      - Notification category for emoji mapping
   * @param params.notificationId - Herald notification ID for tracking
   */
  async sendNotification(params: {
    chatId: string;
    protocolName: string;
    subject: string;
    body: string;
    category: string;
    notificationId: string;
  }): Promise<{ messageId: string }> {
    if (!this.enabled || !this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const emoji = this.getCategoryEmoji(params.category);
    const html = this.formatMessage(params, emoji);

    const result = await this.bot.sendMessage(params.chatId, html, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🔇 Mute this protocol',
              callback_data: `mute_${params.notificationId}`,
            },
          ],
        ],
      },
    });

    return { messageId: String(result.message_id) };
  }

  /**
   * Format Telegram HTML message.
   * Keeps it concise — Telegram messages have a 4096 char limit.
   */
  formatMessage(
    params: {
      protocolName: string;
      subject: string;
      body: string;
      category: string;
    },
    emoji: string,
  ): string {
    // Truncate body to fit within Telegram limits
    const maxBody = 2000;
    const body =
      params.body.length > maxBody
        ? params.body.slice(0, maxBody) + '…'
        : params.body;

    return [
      `${emoji} <b>${this.escapeHtml(params.protocolName)}</b>`,
      '',
      `<b>${this.escapeHtml(params.subject)}</b>`,
      '',
      this.escapeHtml(body),
      '',
      `<i>via Herald • ${params.category}</i>`,
    ].join('\n');
  }

  private getCategoryEmoji(category: string): string {
    const map: Record<string, string> = {
      defi: '💰',
      governance: '🗳️',
      system: '⚙️',
      marketing: '📢',
    };
    return map[category] ?? '🔔';
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
