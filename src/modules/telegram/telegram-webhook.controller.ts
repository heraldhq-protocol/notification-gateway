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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TelegramWebhookService } from './telegram-webhook.service';
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
    private readonly telegramService: TelegramService,
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
}
