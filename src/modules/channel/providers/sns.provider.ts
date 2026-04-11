import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SNSClient,
  PublishCommand,
  type PublishCommandInput,
} from '@aws-sdk/client-sns';

/**
 * SnsService — sends SMS notifications via AWS SNS.
 *
 * Uses the Transactional message type for higher delivery priority.
 * SMS is used by verified protocols to deliver important messages
 * and OTPs to their users via Herald.
 *
 * SEC-001: Phone number is received as a plaintext parameter, used only
 * for the PublishCommand, and NEVER logged or stored.
 */
@Injectable()
export class SnsService implements OnModuleInit {
  private readonly logger = new Logger(SnsService.name);
  private client: SNSClient | null = null;
  private enabled = false;
  private senderId: string;

  constructor(private readonly config: ConfigService) {
    this.senderId = this.config.get<string>('SNS_SENDER_ID', 'Herald');
  }

  async onModuleInit(): Promise<void> {
    const region = this.config.get<string>('AWS_REGION', 'us-east-1');

    try {
      this.client = new SNSClient({ region });
      this.enabled = true;
      this.logger.log(`AWS SNS initialized in ${region}`);
    } catch (err) {
      this.logger.error('Failed to initialize AWS SNS', {
        error: (err as Error).message,
      });
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send an SMS notification to a phone number.
   *
   * SMS budgets:
   *   - DeFi/System (urgent): up to 320 chars (2 segments)
   *   - Governance/Marketing (non-urgent): 160 chars (1 segment)
   *
   * @param params.phone        - E.164 phone number (decrypted, in-memory only)
   * @param params.protocolName - Protocol display name
   * @param params.subject      - Notification subject
   * @param params.body         - Notification body
   * @param params.category     - Notification category for urgency classification
   */
  async sendSms(params: {
    phone: string;
    protocolName: string;
    subject: string;
    body: string;
    category: string;
  }): Promise<{ messageId: string }> {
    if (!this.enabled || !this.client) {
      throw new Error('AWS SNS not initialized');
    }

    const isUrgent = ['defi', 'system'].includes(params.category);
    const maxChars = isUrgent ? 320 : 160;
    const message = this.formatSms(params, maxChars);

    const input: PublishCommandInput = {
      PhoneNumber: params.phone,
      Message: message,
      MessageAttributes: {
        'AWS.SNS.SMS.SenderID': {
          DataType: 'String',
          StringValue: this.senderId,
        },
        'AWS.SNS.SMS.SMSType': {
          DataType: 'String',
          StringValue: 'Transactional', // Higher delivery priority
        },
      },
    };

    const result = await this.client.send(new PublishCommand(input));

    if (!result.MessageId) {
      throw new Error('SNS returned no MessageId');
    }

    return { messageId: result.MessageId };
  }

  /**
   * Format SMS message within character budget.
   * Template: "[Protocol] Subject: Body (via Herald)"
   */
  formatSms(
    params: {
      protocolName: string;
      subject: string;
      body: string;
    },
    maxChars: number,
  ): string {
    const suffix = ' (via Herald)';
    const prefix = `[${params.protocolName}] `;
    const subjectLine = `${params.subject}: `;

    const overhead = prefix.length + subjectLine.length + suffix.length;
    const bodyBudget = Math.max(0, maxChars - overhead);

    const body =
      params.body.length > bodyBudget
        ? params.body.slice(0, bodyBudget - 1) + '…'
        : params.body;

    return `${prefix}${subjectLine}${body}${suffix}`;
  }
}
