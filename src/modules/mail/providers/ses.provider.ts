import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SESClient,
  SendRawEmailCommand,
  GetSendQuotaCommand,
} from '@aws-sdk/client-ses';
import * as nodemailer from 'nodemailer';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './provider.interface';

/**
 * SES Provider — Production: AWS SES for highest deliverability.
 * Uses nodemailer to build MIME messages, sends via SES raw email API.
 */
@Injectable()
export class SesProvider implements IMailProvider {
  readonly name = 'ses';
  private readonly client: SESClient;
  private readonly logger = new Logger(SesProvider.name);

  constructor(private readonly config: ConfigService) {
    this.client = new SESClient({
      region: config.get('SES_REGION', 'us-east-1'),
    });
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    // Build raw MIME email using nodemailer
    const transporter = nodemailer.createTransport({ streamTransport: true });
    const info = await transporter.sendMail({
      from: message.from,
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      headers: {
        ...message.headers,
        'X-SES-CONFIGURATION-SET': this.config.get(
          'SES_CONFIGURATION_SET',
          'herald-main',
        ),
      },
    });

    // Extract raw MIME data from the stream
    const chunks: Buffer[] = [];
    for await (const chunk of info.message) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const rawEmail = Buffer.concat(chunks);

    // Send via SES raw email API
    const result = await this.client.send(
      new SendRawEmailCommand({
        RawMessage: { Data: rawEmail },
      }),
    );

    return {
      messageId: result.MessageId ?? info.messageId,
      provider: 'ses',
    };
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.client.send(new GetSendQuotaCommand({}));
      return true;
    } catch {
      return false;
    }
  }
}
