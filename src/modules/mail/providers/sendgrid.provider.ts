import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sgMail from '@sendgrid/mail';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './provider.interface';

@Injectable()
export class SendgridProvider implements IMailProvider {
  readonly name = 'sendgrid';
  private readonly logger = new Logger(SendgridProvider.name);

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('SENDGRID_API_KEY');
    if (apiKey) {
      sgMail.setApiKey(apiKey);
    }
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    try {
      const response = await sgMail.send({
        to: message.to,
        from: message.from,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
      });

      const messageId = response[0]?.headers['x-message-id'] || 'unknown';

      return {
        messageId,
        provider: 'sendgrid',
      };
    } catch (error) {
      this.logger.error('SendGrid dispatch failed', {
        error: (error as Error).message,
        // SECURITY: Do not log message.to
      });
      throw error;
    }
  }

  async verifyConnection(): Promise<boolean> {
    const apiKey = this.config.get<string>('SENDGRID_API_KEY');
    await Promise.resolve();

    return !!apiKey;
  }
}
