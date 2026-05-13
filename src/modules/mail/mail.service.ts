import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmtpProvider } from './providers/smtp.provider';
import { SesProvider } from './providers/ses.provider';
import { ResendProvider } from './providers/resend.provider';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './providers/provider.interface';

/**
 * MailService — environment-aware email dispatch.
 *
 * Provider selection:
 *   development → SmtpProvider (Nodemailer + Mailhog)
 *   staging     → ResendProvider (Resend API)
 *   production  → ResendProvider until SES gains production access,
 *                  then switch to SesProvider
 *
 * SECURITY: The 'to' field MUST NOT appear in any logs.
 */
@Injectable()
export class MailService {
  private readonly provider: IMailProvider;
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly smtpProvider: SmtpProvider,
    private readonly sesProvider: SesProvider,
    private readonly resendProvider: ResendProvider,
    private readonly config: ConfigService,
  ) {
    const mailProvider = this.config.get<string>('MAIL_PROVIDER', 'smtp');
    switch (mailProvider) {
      case 'ses':
        this.provider = this.sesProvider;
        break;
      case 'resend':
        this.provider = this.resendProvider;
        break;
      case 'smtp':
      default:
        this.provider = this.smtpProvider;
        break;
    }
  }

  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    return this.provider.send(message);
  }

  async verifyConnection(): Promise<boolean> {
    return this.provider.verifyConnection();
  }
}
