import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { SolanaModule } from '../../solana/solana.module';
import { NotifyModule } from '../notify/notify.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SolanaModule, NotifyModule, AuthModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
