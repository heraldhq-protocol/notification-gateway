import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { CreateEmailOptions } from 'resend';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './provider.interface';

@Injectable()
export class ResendProvider implements IMailProvider {
  readonly name = 'resend';
  private readonly client: Resend;
  private readonly logger = new Logger(ResendProvider.name);

  private readonly usable: boolean;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('RESEND_API_KEY');
    this.usable = !!apiKey;
    if (!this.usable) {
      this.logger.warn('RESEND_API_KEY not set — ResendProvider disabled');
      this.client = new Resend('');
      return;
    }
    this.client = new Resend(apiKey);
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    if (!this.usable) {
      throw new Error(
        'Cannot send via Resend: RESEND_API_KEY is not configured',
      );
    }

    const payload: CreateEmailOptions = {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
    };

    if (message.replyTo) {
      payload.reply_to = message.replyTo;
    }

    if (message.headers) {
      payload.headers = message.headers;
    }

    const { data, error } = await this.client.emails.send(payload);

    if (error || !data) {
      throw new Error(
        `Resend send failed: ${error?.message ?? 'unknown error'}`,
      );
    }

    return { messageId: data.id, provider: 'resend' };
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.usable) return false;
    try {
      const { data, error } = await this.client.domains.list();
      return !error && data !== null;
    } catch {
      return false;
    }
  }
}
