import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SESClient,
  SendRawEmailCommand,
  GetSendQuotaCommand,
} from '@aws-sdk/client-ses';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../../database/prisma.service';
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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.client = new SESClient({
      region: config.get('AWS_REGION', 'us-east-1'),
    });
  }

  private async getBimiConfig(from: string) {
    try {
      // Extract domain from "Name <email@domain.com>" or "email@domain.com"
      const emailMatch = from.match(/<([^>]+)>|([^\s]+@[^\s]+)/);
      const email = emailMatch ? emailMatch[1] || emailMatch[2] : from;
      const domain = email.split('@')[1];

      if (!domain) return null;

      // 1. Try to find custom BIMI record in DB
      const bimi = await this.prisma.bimiRecord.findFirst({
        where: {
          domain,
          isVerified: true,
        },
        select: { selector: true },
      });

      if (bimi) return bimi;

      // 2. Fallback for Herald sandbox/test domains
      const heraldDomains = [
        'useherald.xyz',
        'herald.xyz',
        'sandbox.useherald.xyz',
      ];
      if (heraldDomains.includes(domain)) {
        return { selector: 'herald' }; // We'll consistently use 'herald' selector for our own domains
      }

      return null;
    } catch (err) {
      this.logger.warn(`Failed to lookup BIMI config for ${from}:`, err);
      return null;
    }
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    try {
      // Build raw MIME email using nodemailer
      const transporter = nodemailer.createTransport({ streamTransport: true });
      const configSet = this.config.get<string>('SES_CONFIGURATION_SET');

      // BIMI Integration: Inject BIMI-Selector header if verified config exists
      const bimiConfig = await this.getBimiConfig(message.from);

      const headers: any = { ...message.headers };

      if (configSet) {
        headers['X-SES-CONFIGURATION-SET'] = configSet;
      }

      if (bimiConfig?.selector && bimiConfig.selector !== 'default') {
        headers['BIMI-Selector'] = `v=BIMI1; s=${bimiConfig.selector};`;
      }

      const info = await transporter.sendMail({
        from: message.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers,
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
    } catch (err: any) {
      console.error('\n\n================ SES FATAL ERROR ================');
      console.error(err);
      console.error('=================================================\n\n');
      throw err;
    }
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
