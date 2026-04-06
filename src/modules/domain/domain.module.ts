import { Module } from '@nestjs/common';
import { DomainController } from './domain.controller';
import { DkimService } from './dkim.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [DomainController],
  providers: [DkimService],
  exports: [DkimService],
})
export class DomainModule {}
