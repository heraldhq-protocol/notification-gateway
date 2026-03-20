import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './provider.interface.js';

/**
 * Resend Provider — Staging: Resend API for reliable sandbox delivery.
 */
@Injectable()
export class ResendProvider implements IMailProvider {
  readonly name = 'resend';
  private client: Resend | null = null;
  private readonly logger = new Logger(ResendProvider.name);

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (apiKey) {
      this.client = new Resend(apiKey);
    }
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    if (!this.client) throw new Error('Resend API key not configured');

    const { data, error } = await this.client.emails.send({
      from: message.from,
      to: message.to,
      reply_to: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }

    return { messageId: data!.id, provider: 'resend' };
  }

  async verifyConnection(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.apiKeys.list();
      return true;
    } catch {
      return false;
    }
  }
}
