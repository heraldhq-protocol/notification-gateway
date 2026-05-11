import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  HttpException,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { PrismaService } from '../../database/prisma.service';
import { QueueService } from '../queue/queue.service';
import { SandboxService } from './sandbox.service';
import { SandboxSendDto, SandboxSendResponseDto } from './dto/sandbox.dto';

@ApiTags('Sandbox Playground')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/sandbox')
export class SandboxController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly sandboxService: SandboxService,
  ) {}

  @Post('send')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiredScopes('notify:write')
  @ApiOperation({
    summary: 'Send a playground test notification to your configured test contacts',
    description:
      'Requires a sandbox (hrld_test_) API key. Delivers directly to the ' +
      'protocol\'s test_email, test_telegram_id, and test_phone from Settings. ' +
      'No wallet address is needed. Limited to 25 sends per day.',
  })
  @ApiResponse({
    status: 202,
    description: 'Playground notification queued for delivery to test contacts',
    type: SandboxSendResponseDto,
  })
  @ApiResponse({ status: 400, description: 'No test contacts configured' })
  @ApiResponse({ status: 403, description: 'Production API key rejected' })
  @ApiResponse({ status: 429, description: 'Daily playground limit exceeded' })
  async sendTest(
    @Body() dto: SandboxSendDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ): Promise<SandboxSendResponseDto> {
    const notificationId = uuidv4();
    const walletHash = this.sha256(`playground:${protocol.protocolId}`);
    const subjectHash = this.sha256(dto.subject);

    // 1. Reject production API keys — sandbox endpoint only
    if (protocol.environment !== 'sandbox') {
      throw new HttpException(
        {
          error: 'SANDBOX_ENDPOINT_REQUIRES_SANDBOX_KEY',
          message:
            'The /v1/sandbox/send endpoint requires a sandbox (hrld_test_) API key. ' +
            'Use a sandbox key for playground testing, or use POST /v1/notify for production sends.',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    // 2. Check playground daily limit (25/day, separate Redis counter)
    const limit = await this.sandboxService.checkPlaygroundLimit(
      protocol.apiKeyId,
    );

    if (!limit.allowed) {
      throw new HttpException(
        {
          error: 'PLAYGROUND_LIMIT_EXCEEDED',
          message:
            'Playground daily limit of 25 sends reached. Resets at midnight UTC. ' +
            'Use POST /v1/notify with your sandbox key for additional test sends ' +
            '(separate daily limit applies).',
          remaining_today: 0,
          daily_limit: limit.dailyLimit,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 3. Load test contacts from protocol_settings
    const settings = await this.prisma.protocol_settings.findUnique({
      where: { protocol_id: protocol.protocolId },
    });

    const testEmail = settings?.test_email;
    const testTelegramId = settings?.test_telegram_id;
    const testPhone = settings?.test_phone;

    if (!testEmail && !testTelegramId && !testPhone) {
      throw new BadRequestException({
        error: 'SANDBOX_NO_TEST_CONTACT',
        message:
          'No test contacts configured. Set your test_email, test_telegram_id, ' +
          'or test_phone in the dashboard Settings > Sandbox Test Contacts page.',
      });
    }

    const testContact: {
      email?: string;
      telegramChatId?: string;
      phone?: string;
    } = {
      email: testEmail ?? undefined,
      telegramChatId: testTelegramId ?? undefined,
      phone: testPhone ?? undefined,
    };

    // 4. Create Notification record
    await this.prisma.notification.create({
      data: {
        id: notificationId,
        protocolId: protocol.protocolId,
        walletHash,
        subjectHash,
        status: 'queued',
        category: dto.category ?? 'defi',
        writeReceipt: false,
      },
    });

    // 5. Enqueue async delivery via existing BullMQ worker
    const prefixedSubject = `[HERALD TEST] ${dto.subject}`;

    try {
      await this.queueService.enqueueNotification({
        notificationId,
        protocolId: protocol.protocolId,
        protocolPubkey: protocol.protocolPubkey,
        protocolName: protocol.name ?? 'Unknown Protocol',
        wallet: 'sandbox-playground',
        walletHash,
        subject: prefixedSubject,
        body: dto.body,
        category: dto.category ?? 'defi',
        writeReceipt: false,
        digestMode: false,
        priority: 'normal',
        preferredChannel: dto.preferred_channel,
        isSandbox: true,
        testContact,
        tier: protocol.tier,
      });
    } catch (error) {
      await this.prisma.notification
        .update({
          where: { id: notificationId },
          data: { status: 'failed', errorCode: 'ENQUEUE_FAILED' },
        })
        .catch(() => {});

      return {
        notification_id: notificationId,
        status: 'failed',
        error_code: 'ENQUEUE_FAILED',
        test_contact: {
          email: testEmail ? this.maskEmail(testEmail) : null,
          telegram: testTelegramId ? 'configured' : null,
          sms: testPhone ? this.maskPhone(testPhone) : null,
        },
        remaining_today: limit.remaining,
        daily_limit: limit.dailyLimit,
        sandbox_mode: true,
        sandbox_notes: [
          'Failed to enqueue playground test for delivery.',
          'Service temporarily unavailable — retry later.',
        ],
      };
    }

    // 6. Record sandbox receipt
    await this.sandboxService
      .recordSandboxReceipt({
        apiKeyId: protocol.apiKeyId,
        notificationId,
        walletHash,
        subject: prefixedSubject,
        status: 'queued',
        channel: dto.preferred_channel ?? 'email',
      })
      .catch(() => {});

    // 7. Increment playground usage counter (after successful enqueue)
    await this.sandboxService.incrementPlaygroundUsage(protocol.apiKeyId);

    const remainingAfter = limit.remaining - 1;

    // Build which channels will be used
    const activeChannels: string[] = [];
    if (testEmail) activeChannels.push('email');
    if (testTelegramId) activeChannels.push('Telegram');
    if (testPhone) activeChannels.push('SMS');

    return {
      notification_id: notificationId,
      status: 'queued',
      test_contact: {
        email: testEmail ? this.maskEmail(testEmail) : null,
        telegram: testTelegramId ? 'configured' : null,
        sms: testPhone ? this.maskPhone(testPhone) : null,
      },
      remaining_today: remainingAfter,
      daily_limit: limit.dailyLimit,
      sandbox_mode: true,
      sandbox_notes: [
        `Delivering playground test to ${activeChannels.join(', ')}.`,
        'This notification will NOT count against your production monthly quota.',
        `Playground daily usage: ${remainingAfter} of ${limit.dailyLimit} remaining after this send.`,
        'ZK receipt disabled in sandbox mode.',
      ],
    };
  }

  private sha256(input: string): string {
    return createHash('sha256').update(input).digest('hex');
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 2)}***@${domain}`;
  }

  private maskPhone(phone: string): string {
    return `${phone.slice(0, 4)}***${phone.slice(-4)}`;
  }
}
