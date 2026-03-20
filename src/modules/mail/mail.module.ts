import { Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { SmtpProvider } from './providers/smtp.provider.js';
import { ResendProvider } from './providers/resend.provider.js';
import { SesProvider } from './providers/ses.provider.js';
import { SendgridProvider } from './providers/sendgrid.provider.js';

@Module({
  providers: [MailService, SmtpProvider, ResendProvider, SesProvider, SendgridProvider],
  exports: [MailService],
})
export class MailModule { }
