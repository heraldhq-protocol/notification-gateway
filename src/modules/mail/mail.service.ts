import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SmtpProvider } from './providers/smtp.provider.js';
import { ResendProvider } from './providers/resend.provider.js';
import { SesProvider } from './providers/ses.provider.js';
import type {
  IMailProvider,
  SendEmailMessage,
  SendEmailResult,
} from './providers/provider.interface.js';

/**
 * MailService — environment-aware email dispatch with automatic fallback.
 *
 * Provider selection:
 *   development → SmtpProvider (Nodemailer + Mailhog)
 *   staging     → ResendProvider (Resend API)
 *   production  → SesProvider (AWS SES), fallback to SmtpProvider
 *
 * SECURITY: The 'to' field MUST NOT appear in any logs.
 */
@Injectable()
export class MailService {
  private readonly primaryProvider: IMailProvider;
  private readonly fallbackProvider: IMailProvider | null;
  private readonly logger = new Logger(MailService.name);

  constructor(
    private readonly smtpProvider: SmtpProvider,
    private readonly resendProvider: ResendProvider,
    private readonly sesProvider: SesProvider,
    private readonly config: ConfigService,
  ) {
    const mailProvider = this.config.get<string>('MAIL_PROVIDER', 'smtp');
    switch (mailProvider) {
      case 'resend':
        this.primaryProvider = this.resendProvider;
        this.fallbackProvider = null;
        break;
      case 'ses':
        this.primaryProvider = this.sesProvider;
        this.fallbackProvider = this.smtpProvider; // fallback
        break;
      case 'smtp':
      default:
        this.primaryProvider = this.smtpProvider;
        this.fallbackProvider = null;
        break;
    }
  }

  /**
   * Send an email through the configured provider with automatic fallback.
   */
  async send(message: SendEmailMessage): Promise<SendEmailResult> {
    try {
      return await this.primaryProvider.send(message);
    } catch (err) {
      this.logger.error('Primary mail provider failed', {
        provider: this.primaryProvider.name,
        error: (err as Error).message,
        // NEVER log 'to' address
      });

      if (this.fallbackProvider) {
        this.logger.warn('Falling back to secondary provider', {
          fallback: this.fallbackProvider.name,
        });
        return this.fallbackProvider.send(message);
      }

      throw err;
    }
  }

  /** Verify the primary provider connection. */
  async verifyConnection(): Promise<boolean> {
    return this.primaryProvider.verifyConnection();
  }
}
