import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { InternalCampaignController } from './internal-campaign.controller';
import { AdminService } from './admin.service';
import { SolanaModule } from '../../solana/solana.module';
import { NotifyModule } from '../notify/notify.module';
import { AuthModule } from '../auth/auth.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  // PrismaModule is @Global() so PrismaService is available without importing here.
  imports: [SolanaModule, NotifyModule, AuthModule, QueueModule],
  controllers: [AdminController, InternalCampaignController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
