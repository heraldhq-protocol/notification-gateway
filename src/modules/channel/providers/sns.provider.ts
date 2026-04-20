import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SNSClient,
  PublishCommand,
  type PublishCommandInput,
} from '@aws-sdk/client-sns';
import { parseMarkdownLinks } from '../../../common/utils/link-parser';

export interface SmsMessageParams {
  protocolName: string;
  subject: string;
  body: string;
  category?: string;
}

export interface SmsMessageResult {
  body: string;
  segments: number;
  encoding: 'GSM-7' | 'UCS-2';
}

// eslint-disable-next-line no-control-regex
const GSM_7_REGEX = /^[\x00-\x7F\n\r\t ]+$/;

const GSM_7_MAX_LENGTH = 160;
const GSM_7_MULTI_MAX_LENGTH = 153;
const UCS_2_MAX_LENGTH = 70;
const UCS_2_MULTI_MAX_LENGTH = 67;

@Injectable()
export class SnsService implements OnModuleInit {
  private readonly logger = new Logger(SnsService.name);
  private client: SNSClient | null = null;
  private enabled = false;
  private senderId: string;

  constructor(private readonly config: ConfigService) {
    this.senderId = this.config.get<string>('SNS_SENDER_ID', 'Herald');
  }

  onModuleInit(): void {
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
   * Build SMS body with optimal encoding and segmentation.
   * Automatically detects GSM-7 vs UCS-2 encoding.
   * Uses word boundary truncation with character cutoff fallback.
   */
  buildSmsBody(params: SmsMessageParams): SmsMessageResult {
    const { cleanText } = parseMarkdownLinks(params.body);

    const isGsm7 = this.isGsm7Encoding(cleanText);
    const maxSingle = isGsm7 ? GSM_7_MAX_LENGTH : UCS_2_MAX_LENGTH;

    const prefix = `[${params.protocolName}] `;
    const subjectLine = `${params.subject}: `;
    const suffix = ' (via Herald)';

    const overhead = prefix.length + subjectLine.length + suffix.length;
    const bodyBudget = Math.max(0, maxSingle - overhead);

    let truncatedBody = this.truncateToWordBoundary(cleanText, bodyBudget);
    if (truncatedBody.length === 0) {
      truncatedBody = this.truncateToCharLimit(cleanText, bodyBudget);
    }

    const body = `${prefix}${subjectLine}${truncatedBody}${suffix}`;
    const segments = this.calculateSegments(body, isGsm7);

    return {
      body,
      segments,
      encoding: isGsm7 ? 'GSM-7' : 'UCS-2',
    };
  }

  /**
   * Check if text uses GSM-7 alphabet (ASCII-compatible).
   */
  private isGsm7Encoding(text: string): boolean {
    return GSM_7_REGEX.test(text);
  }

  /**
   * Truncate text to word boundary.
   * Falls back to character cutoff if no word boundary found.
   */
  private truncateToWordBoundary(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;

    const truncated = text.slice(0, maxLength);
    const lastSpace = truncated.lastIndexOf(' ');

    if (lastSpace > maxLength * 0.5) {
      return truncated.slice(0, lastSpace);
    }

    const lastPunctuation = Math.max(
      truncated.lastIndexOf('.'),
      truncated.lastIndexOf('!'),
      truncated.lastIndexOf('?'),
    );

    if (lastPunctuation > maxLength * 0.5) {
      return truncated.slice(0, lastPunctuation + 1);
    }

    return this.truncateToCharLimit(text, maxLength);
  }

  /**
   * Fallback: truncate to exact character limit with ellipsis.
   */
  private truncateToCharLimit(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, Math.max(0, maxLength - 1)) + '…';
  }

  /**
   * Calculate number of message segments.
   */
  private calculateSegments(message: string, isGsm7: boolean): number {
    const maxPerSegment = isGsm7
      ? GSM_7_MULTI_MAX_LENGTH
      : UCS_2_MULTI_MAX_LENGTH;
    return Math.ceil(message.length / maxPerSegment);
  }

  /**
   * Send an SMS notification to a phone number.
   */
  async sendSms(params: {
    phone: string;
    protocolName: string;
    subject: string;
    body: string;
    category?: string;
  }): Promise<{ messageId: string }> {
    if (!this.enabled || !this.client) {
      throw new Error('AWS SNS not initialized');
    }

    const { body: message } = this.buildSmsBody({
      protocolName: params.protocolName,
      subject: params.subject,
      body: params.body,
      category: params.category,
    });

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
          StringValue: 'Transactional',
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
   * Legacy method for backward compatibility.
   */
  formatSms(
    params: {
      protocolName: string;
      subject: string;
      body: string;
    },
    maxChars: number,
  ): string {
    const { body } = this.buildSmsBody({
      protocolName: params.protocolName,
      subject: params.subject,
      body: params.body,
    });
    return body;
  }
}
