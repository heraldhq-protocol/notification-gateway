import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../database/prisma.service';

const START_PATTERN = /^\/start\s+([1-9A-HJ-NP-Za-km-z]{32,44})$/;

@Injectable()
export class TelegramWebhookService implements OnModuleInit {
  private readonly logger = new Logger(TelegramWebhookService.name);
  private bot: any;
  private enabled = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token) return;

    try {
      const TelegramBot = (await import('node-telegram-bot-api')).default;
      this.bot = new TelegramBot(token, { polling: false });
      this.enabled = true;
    } catch (err) {
      this.logger.error('Failed to init Telegram bot for webhook handling', {
        error: (err as Error).message,
      });
    }
  }

  async handleUpdate(update: Record<string, any>): Promise<void> {
    if (!this.enabled) return;

    const message = update?.message;
    if (!message?.text) return;

    const chatId = String(message.chat?.id);
    const username: string | undefined = message.from?.username;
    const text: string = message.text.trim();

    const match = START_PATTERN.exec(text);
    if (match) {
      await this.handleStartConnect(chatId, match[1], username);
      return;
    }

    if (text === '/start') {
      await this.sendWelcome(chatId);
    }
  }

  private async handleStartConnect(
    chatId: string,
    walletPubkey: string,
    username?: string,
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Replace any existing pending record for this wallet
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

    this.logger.log(`Telegram connect initiated — wallet=${walletPubkey} chat=${chatId}`);

    if (this.bot) {
      await this.bot.sendMessage(
        chatId,
        '✅ <b>Almost there!</b>\n\nReturn to the Herald portal to complete the connection. This link expires in 10 minutes.',
        { parse_mode: 'HTML' },
      ).catch((err: Error) => {
        this.logger.warn(`Could not send confirmation to ${chatId}: ${err.message}`);
      });
    }
  }

  private async sendWelcome(chatId: string): Promise<void> {
    if (!this.bot) return;
    await this.bot.sendMessage(
      chatId,
      '👋 <b>Welcome to Herald!</b>\n\nTo connect your Telegram account, go to the Herald developer portal and click <b>Connect Telegram</b>. You\'ll be given a unique deep link to start here.',
      { parse_mode: 'HTML' },
    ).catch(() => undefined);
  }

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
      this.logger.debug(`Failed to record Telegram click for ${notifId}: ${(err as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanExpiredPendingConnections(): Promise<void> {
    const { count } = await this.prisma.telegramPendingConnection.deleteMany({
      where: {
        OR: [
          { expiresAt: { lt: new Date() } },
          { claimed: true },
        ],
      },
    });
    if (count > 0) {
      this.logger.debug(`Cleaned ${count} expired/claimed Telegram pending connections`);
    }
  }
}
