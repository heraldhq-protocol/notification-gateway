import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  Res,
  Headers,
  Logger,
  HttpCode,
  HttpStatus,
  ForbiddenException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TelegramWebhookService } from './telegram-webhook.service';
import { TelegramMigrationService } from './telegram-migration.service';
import { TelegramService } from '../channel/providers/telegram.provider';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

@ApiTags('Telegram')
@Controller('v1/tg')
export class TelegramWebhookController {
  private readonly logger = new Logger(TelegramWebhookController.name);

  constructor(
    private readonly webhookService: TelegramWebhookService,
    private readonly migrationService: TelegramMigrationService,
    private readonly telegramService: TelegramService,
    private readonly config: ConfigService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Body() update: Record<string, any>,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ): Promise<void> {
    if (!this.webhookService.verifySecret(secret)) {
      throw new ForbiddenException('Invalid webhook secret');
    }

    try {
      await this.webhookService.handleUpdate(update);
    } catch (err) {
      this.logger.error('Telegram webhook processing failed', {
        error: (err as Error).message,
      });
    }
  }

  @Get('c/:notifId')
  trackClick(
    @Param('notifId') notifId: string,
    @Query('url') urlB64: string,
    @Res() res: Response,
  ): void {
    let destination = 'https://useherald.xyz';
    if (urlB64) {
      try {
        destination = Buffer.from(urlB64, 'base64url').toString('utf8');
        const parsed = new URL(destination);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          destination = 'https://useherald.xyz';
        }
      } catch {
        destination = 'https://useherald.xyz';
      }
    }

    this.webhookService.recordClickAsync(notifId).catch(() => undefined);
    res.redirect(302, destination);
  }

  /**
   * Preview how a Telegram message will be rendered — without sending it.
   * Returns the formatted text and inline keyboard layout.
   * Useful for protocol admins to verify appearance before a campaign.
   */
  @Post('preview')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('notify:send')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Preview Telegram message rendering (no send)' })
  @HttpCode(HttpStatus.OK)
  previewMessage(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Body()
    body: {
      subject: string;
      body: string;
      category: string;
      bannerUrl?: string;
      videoUrl?: string;
    },
  ) {
    const result = this.telegramService.buildMessage({
      protocolName: protocol.name ?? 'Your Protocol',
      protocolId: protocol.protocolId,
      subject: body.subject ?? '',
      body: body.body ?? '',
      category: body.category ?? 'system',
      tier: protocol.tier,
      bannerUrl: body.bannerUrl,
      videoUrl: body.videoUrl,
    });

    return {
      text: result.text,
      hasMedia: !!result.media,
      mediaType: result.media?.type ?? null,
      inlineButtonCount: result.inlineButtons.flat().length,
      inlineButtons: result.inlineButtons,
    };
  }

  /**
   * Clear cached bot-block markers (tg:blocked:*). Use after fixing a bot
   * misconfiguration so delivery stops bailing early on stale 403 caches.
   * Pass ?chatId=<id> to clear a single chat, or omit to clear all.
   */
  @Delete('blocked')
  @UseGuards(AuthGuard, ScopeGuard)
  @RequiredScopes('notify:send')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Clear cached Telegram bot-block markers' })
  @HttpCode(HttpStatus.OK)
  async clearBlocked(
    @ApiKey() _protocol: AuthenticatedProtocol,
    @Query('chatId') chatId?: string,
  ): Promise<{ cleared: number }> {
    const cleared = await this.webhookService.clearBlockedChats(chatId?.trim() || undefined);
    this.logger.log(`Cleared ${cleared} tg:blocked marker(s)${chatId ? ` for chat ${chatId}` : ''}`);
    return { cleared };
  }

  /**
   * POST /v1/tg/custom-webhook/:protocolId
   *
   * Receives updates from a protocol's custom Telegram bot.
   * When a user sends /start to the custom bot, their chat is marked as
   * migrated so future notifications are delivered via the custom bot.
   *
   * The webhook is registered by the admin-api when the custom bot token is saved.
   * Secured via the gateway's TELEGRAM_WEBHOOK_SECRET header.
   */
  @Post('custom-webhook/:protocolId')
  @HttpCode(HttpStatus.OK)
  async handleCustomBotWebhook(
    @Param('protocolId') protocolId: string,
    @Body() update: Record<string, any>,
    @Headers('x-telegram-bot-api-secret-token') secret?: string,
  ): Promise<void> {
    if (!this.webhookService.verifySecret(secret)) {
      throw new ForbiddenException('Invalid webhook secret');
    }

    const message = update?.message;
    if (!message?.text) return;

    const chatId = String(message.chat?.id);
    const text: string = message.text.trim();

    // Accept /start with the migration payload OR bare /start (user tapped Start button)
    const isMigrationStart =
      text.startsWith('/start hrld_') ||
      text === `/start hrld_${protocolId}` ||
      text === '/start';

    if (isMigrationStart) {
      await this.migrationService.markMigrated(chatId, protocolId);
      this.logger.log(
        `Custom bot migration confirmed: chat=${chatId} protocol=${protocolId}`,
      );

      // Fetch the custom bot token so we can reply from the correct bot
      await this.migrationService
        .sendCustomBotWelcome(chatId, protocolId)
        .catch(() => undefined);
    }
  }

  /**
   * POST /v1/tg/migrate/:protocolId
   *
   * Internal endpoint — triggers migration prompt fan-out to all of a protocol's
   * active Telegram subscribers. Called by the admin-api after a custom bot token
   * is saved. Secured via X-Internal-Secret header.
   */
  @Post('migrate/:protocolId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Trigger Telegram migration fan-out (internal)' })
  async triggerMigration(
    @Param('protocolId') protocolId: string,
    @Headers('x-internal-secret') secret?: string,
  ): Promise<{ sent: number; skipped: number }> {
    this.verifyInternalSecret(secret);
    const result = await this.migrationService.sendMigrationPrompts(protocolId);
    this.logger.log(
      `Migration triggered for ${protocolId}: sent=${result.sent} skipped=${result.skipped}`,
    );
    return result;
  }

  /**
   * DELETE /v1/tg/migrate/:protocolId
   *
   * Internal endpoint — clears all migration Redis state for a protocol.
   * Called by the admin-api when a custom bot token is removed.
   */
  @Delete('migrate/:protocolId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clear Telegram migration state (internal)' })
  async clearMigration(
    @Param('protocolId') protocolId: string,
    @Headers('x-internal-secret') secret?: string,
  ): Promise<{ cleared: boolean }> {
    this.verifyInternalSecret(secret);
    await this.migrationService.clearMigrationState(protocolId);
    return { cleared: true };
  }

  private verifyInternalSecret(secret?: string): void {
    const expected = this.config.get<string>('INTERNAL_API_SECRET');
    if (expected && secret !== expected) {
      throw new ForbiddenException('Invalid internal secret');
    }
  }
}
