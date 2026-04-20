import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import {
  parseMarkdownLinks,
  injectVariables,
} from '../../../common/utils/link-parser';

function parseMarkdownToTelegramHtml(text: string): string {
  let result = text;

  result = result.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre>${escapeHtmlForTelegram(code.trim())}</pre>`;
  });

  result = result.replace(/`([^`]+)`/g, (_, code) => {
    return `<code>${escapeHtmlForTelegram(code)}</code>`;
  });

  result = result.replace(/\*\*\*([^*]+)\*\*/g, (_, text) => {
    return `<b>${escapeHtmlForTelegram(text)}</b>`;
  });

  result = result.replace(/\*([^*]+)\*/g, (_, text) => {
    return `<i>${escapeHtmlForTelegram(text)}</i>`;
  });

  result = result.replace(/__([_^]+)__/g, (_, text) => {
    return `<u>${escapeHtmlForTelegram(text)}</u>`;
  });

  result = result.replace(/~~([^~]+)~~/g, (_, text) => {
    return `<s>${escapeHtmlForTelegram(text)}</s>`;
  });

  return result;
}

function escapeHtmlForTelegram(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface TelegramMessageParams {
  protocolName: string;
  protocolId?: string;
  subject: string;
  body: string;
  category: string;
  tier?: number;
  bannerUrl?: string;
  videoUrl?: string;
  templateVariables?: Record<string, string>;
}

export interface TelegramMessageResult {
  text: string;
  media?: InputMediaVideo | InputMediaPhoto;
  inlineButtons: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  url?: string;
  callback_data?: string;
}

interface InputMediaPhoto {
  type: 'photo';
  media: string;
  caption?: string;
  parse_mode?: 'HTML' | 'Markdown';
}

interface InputMediaVideo {
  type: 'video';
  media: string;
  caption?: string;
  parse_mode?: 'HTML' | 'Markdown';
}

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_MAX_CAPTION_LENGTH = 1024;
const DEFAULT_MAX_BUTTONS = 10;

@Injectable()
export class TelegramService implements OnModuleInit {
  private readonly logger = new Logger(TelegramService.name);
  private bot: any;
  private enabled = false;
  private maxButtons: number;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.maxButtons = this.config.get<number>(
      'TELEGRAM_MAX_BUTTONS',
      DEFAULT_MAX_BUTTONS,
    );
  }

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN not configured — Telegram channel disabled',
      );
      return;
    }

    try {
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
   * Build a Telegram message with full formatting and optional media.
   * Parses [text](url) syntax for inline buttons.
   */
  buildMessage(params: TelegramMessageParams): TelegramMessageResult {
    const emoji = this.getCategoryEmoji(params.category);
    const { cleanText, links } = parseMarkdownLinks(params.body);

    const bodyText = cleanText;
    const inlineKeyboardLinks = links.map((link) => ({
      text: link.label,
      url: link.url,
    }));

    const media = this.buildMedia(params.bannerUrl, params.videoUrl);

    const text = this.formatText(
      {
        ...params,
        body: bodyText,
      },
      emoji,
    );

    const inlineButtons = this.buildInlineKeyboard(
      inlineKeyboardLinks,
      [],
      params.protocolId,
    );

    return { text, media, inlineButtons };
  }

  /**
   * Build media object for Telegram API.
   */
  private buildMedia(
    bannerUrl?: string,
    videoUrl?: string,
  ): InputMediaVideo | InputMediaPhoto | undefined {
    if (videoUrl) {
      return {
        type: 'video',
        media: videoUrl,
      };
    }
    if (bannerUrl) {
      return {
        type: 'photo',
        media: bannerUrl,
      };
    }
    return undefined;
  }

  /**
   * Build inline keyboard from extracted links and custom buttons.
   * Combines body links + database custom buttons + mute button.
   */
  buildInlineKeyboard(
    bodyLinks: { text: string; url: string }[],
    customButtons: {
      label?: string;
      urlTemplate?: string;
      text?: string;
      url?: string;
    }[],
    protocolId?: string,
    notificationId?: string,
  ): InlineKeyboardButton[][] {
    const rows: InlineKeyboardButton[][] = [];
    const buttonLimit = this.maxButtons;

    let usedButtons = 0;

    for (const link of bodyLinks) {
      if (usedButtons >= buttonLimit) break;
      rows.push([{ text: link.text, url: link.url }]);
      usedButtons++;
    }

    for (const btn of customButtons) {
      if (usedButtons >= buttonLimit) break;
      rows.push([
        {
          text: btn.label ?? btn.text ?? '',
          url: btn.urlTemplate ?? btn.url ?? '',
        },
      ]);
      usedButtons++;
    }

    if (notificationId && usedButtons < buttonLimit) {
      rows.push([
        {
          text: '🔇 Mute this protocol',
          callback_data: `mute_${notificationId}`,
        },
      ]);
    }

    return rows;
  }

  /**
   * Format text with Telegram HTML.
   * Handles truncation and encoding. Also parses markdown to HTML.
   */
  private formatText(
    params: {
      protocolName: string;
      subject: string;
      body: string;
      category: string;
      tier?: number;
    },
    emoji: string,
  ): string {
    const maxBody = TELEGRAM_MAX_CAPTION_LENGTH;
    let bodyText = params.body;

    bodyText = parseMarkdownToTelegramHtml(bodyText);

    if (bodyText.length > maxBody) {
      bodyText = bodyText.slice(0, maxBody - 1) + '…';
    }

    const lines = [
      `${emoji} <b>${this.escapeHtml(params.protocolName)}</b>`,
      '',
      `<b>${this.escapeHtml(params.subject)}</b>`,
      '',
      bodyText,
    ];

    if ((params.tier ?? 0) < 3) {
      const cat = params.category.charAt(0).toUpperCase() + params.category.slice(1);
      lines.push('', `<i>via Herald • ${cat}</i>`);
    }

    let result = lines.filter((line) => line !== '').join('\n');

    if (result.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      result = result.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1) + '…';
    }

    return result;
  }

  /**
   * Send a notification message to a Telegram chat.
   */
  async sendNotification(params: {
    chatId: string;
    protocolName: string;
    protocolId?: string;
    subject: string;
    body: string;
    category: string;
    notificationId: string;
    tier?: number;
    templateId?: string;
    templateVariables?: Record<string, string>;
    bannerUrl?: string;
    videoUrl?: string;
  }): Promise<{ messageId: string }> {
    if (!this.enabled || !this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const emoji = this.getCategoryEmoji(params.category);
    const { cleanText, links } = parseMarkdownLinks(params.body);

    let messageText: string | undefined;
    const media: InputMediaVideo | InputMediaPhoto | undefined =
      this.buildMedia(params.bannerUrl, params.videoUrl);
    let customButtons: { text: string; url: string }[] = [];

    const tier = params.tier ?? 0;

    if (tier >= 2 && params.protocolId) {
      const templateRecord = await this.loadCustomTemplate(
        params.protocolId,
        params.category,
        params.templateId,
      );

      if (templateRecord) {
        messageText = this.formatCustomMessage(templateRecord.textTemplate, {
          protocolName: params.protocolName,
          subject: params.subject,
          body: cleanText,
          category: params.category,
          tier: params.tier,
          templateVariables: params.templateVariables,
        });

        if (templateRecord.buttons && Array.isArray(templateRecord.buttons)) {
          customButtons = (templateRecord.buttons as any[]).map((btn) => ({
            text: this.injectVariablesIntoText(btn.label || '', {
              ...params.templateVariables,
              protocolName: params.protocolName,
              subject: params.subject,
              body: cleanText,
              category: params.category,
            }),
            url: this.injectVariablesIntoText(btn.urlTemplate || '', {
              ...params.templateVariables,
              protocolName: params.protocolName,
              subject: params.subject,
              body: cleanText,
              category: params.category,
            }),
          }));
        }
      }
    }

    if (!messageText) {
      messageText = this.formatText(
        {
          protocolName: params.protocolName,
          subject: params.subject,
          body: cleanText,
          category: params.category,
          tier: params.tier,
        },
        emoji,
      );
    }

    const inlineLinks = links.map((link) => ({
      text: link.label,
      url: link.url,
    }));

    const inlineKeyboard = this.buildInlineKeyboard(
      inlineLinks,
      customButtons,
      params.protocolId,
      params.notificationId,
    );

    const options: any = {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: inlineKeyboard },
      disable_web_page_preview: false,
    };

    if (media) {
      options.caption = messageText;
      options.caption_parse_mode = 'HTML';

      if (messageText.length > TELEGRAM_MAX_CAPTION_LENGTH) {
        options.caption =
          messageText.slice(0, TELEGRAM_MAX_CAPTION_LENGTH - 1) + '…';
      }

      if (media.type === 'video' && this.bot.sendVideo) {
        const result = await this.bot.sendVideo(
          params.chatId,
          media.media,
          options,
        );
        return { messageId: String(result.message_id) };
      } else {
        const result = await this.bot.sendPhoto(
          params.chatId,
          media.media,
          options,
        );
        return { messageId: String(result.message_id) };
      }
    } else {
      if (messageText.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
        messageText =
          messageText.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1) + '…';
      }
      const result = await this.bot.sendMessage(
        params.chatId,
        messageText,
        options,
      );
      return { messageId: String(result.message_id) };
    }
  }

  /**
   * Get max buttons config for a protocol.
   */
  async getMaxButtons(protocolId?: string): Promise<number> {
    if (!protocolId) return this.maxButtons;
    const protocol = await this.prisma.protocol.findUnique({
      where: { id: protocolId },
      select: { maxTelegramButtons: true },
    });
    return protocol?.maxTelegramButtons ?? this.maxButtons;
  }

  private async loadCustomTemplate(
    protocolId: string,
    category: string,
    templateId?: string,
  ) {
    if (templateId) {
      return this.prisma.telegramTemplate.findFirst({
        where: { id: templateId, protocolId, isActive: true },
      });
    }
    return this.prisma.telegramTemplate.findFirst({
      where: { protocolId, category, isActive: true },
    });
  }

  private formatCustomMessage(
    templateStr: string,
    params: {
      protocolName: string;
      subject: string;
      body: string;
      category: string;
      tier?: number;
      templateVariables?: Record<string, string>;
    },
  ): string {
    let result = this.injectVariablesIntoText(templateStr, {
      protocolName: params.protocolName,
      subject: params.subject,
      body: params.body,
      category: params.category,
      ...(params.templateVariables ?? {}),
    });

    if ((params.tier ?? 0) < 3) {
      const cat = params.category.charAt(0).toUpperCase() + params.category.slice(1);
      result += `\n\n<i>via Herald • ${cat}</i>`;
    }

    if (result.length > TELEGRAM_MAX_MESSAGE_LENGTH) {
      result = result.slice(0, TELEGRAM_MAX_MESSAGE_LENGTH - 1) + '…';
    }

    return result;
  }

  private injectVariablesIntoText(
    template: string,
    variables: Record<string, string>,
  ): string {
    return injectVariables(template, variables);
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
