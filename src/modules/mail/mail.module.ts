import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SmtpProvider } from './providers/smtp.provider';
import { ResendProvider } from './providers/resend.provider';
import { SesProvider } from './providers/ses.provider';
import { SendgridProvider } from './providers/sendgrid.provider';

@Module({
  providers: [
    MailService,
    SmtpProvider,
    ResendProvider,
    SesProvider,
    SendgridProvider,
  ],
  exports: [MailService],
})
export class MailModule {}
