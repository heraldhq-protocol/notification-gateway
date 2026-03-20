import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './provider.interface.js';

/**
 * SMTP Provider — Development: Nodemailer + Mailhog (localhost:1025).
 * All emails sent here appear in the Mailhog web UI at :8025.
 */
@Injectable()
export class SmtpProvider implements IMailProvider {
  readonly name = 'smtp';
  private readonly transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    this.transporter = nodemailer.createTransport({
      host: config.get('SMTP_HOST', 'localhost'),
      port: config.get<number>('SMTP_PORT', 1025),
      auth: config.get('SMTP_USER')
        ? { user: config.get('SMTP_USER'), pass: config.get('SMTP_PASS') }
        : undefined,
      secure: false,
      connectionTimeout: 5_000,
      greetingTimeout: 3_000,
    } as nodemailer.TransportOptions);
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    const info = await this.transporter.sendMail({
      from: message.from,
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: message.headers,
    });
    return { messageId: info.messageId, provider: 'smtp' };
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }
}
