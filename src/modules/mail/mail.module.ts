import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { SmtpProvider } from './providers/smtp.provider';
import { SesProvider } from './providers/ses.provider';
import { ResendProvider } from './providers/resend.provider';
import { SesIdentityService } from './ses-identity.service';

@Module({
  providers: [
    MailService,
    SmtpProvider,
    SesProvider,
    ResendProvider,
    SesIdentityService,
  ],
  exports: [MailService, SesIdentityService],
})
export class MailModule {}
