import { Module } from '@nestjs/common';
import { CampaignController } from './campaign.controller';
import { AuthModule } from '../auth/auth.module';
import { AdminModule } from '../admin/admin.module';

@Module({
  imports: [AuthModule, AdminModule],
  controllers: [CampaignController],
})
export class CampaignModule {}
