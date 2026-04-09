import { Module } from '@nestjs/common';
import { DomainController } from './domain.controller';
import { DkimService } from './dkim.service';
import { AuthModule } from '../auth/auth.module';
import { DnsVerificationService } from './dns-verification.service';
import { BimiService } from './bimi.service';

@Module({
  imports: [AuthModule],
  controllers: [DomainController],
  providers: [DkimService, DnsVerificationService, BimiService],
  exports: [DkimService, DnsVerificationService, BimiService],
})
export class DomainModule {}
