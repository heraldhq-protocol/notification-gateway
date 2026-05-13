/**
 * IMailProvider — contract for all email providers.
 *
 * Implementations: SmtpProvider (dev), ResendProvider (staging/production),
 *                  SesProvider (production when AWS SES approved)
 *
 * SECURITY: The `to` field MUST NEVER be logged.
 */
export interface IMailProvider {
  readonly name: string;
  send(message: SendEmailMessage): Promise<SendEmailResult>;
  verifyConnection(): Promise<boolean>;
}

export interface SendEmailMessage {
  to: string; // SECURITY: Never log this field
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  messageId: string;
  provider: 'ses' | 'smtp' | 'resend';
}
