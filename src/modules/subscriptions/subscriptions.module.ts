import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SubscriptionsService } from './subscriptions.service';
import { SubscriptionsController, InternalSubscriptionsController } from './subscriptions.controller';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../database/prisma.module';

@Module({
  imports: [ConfigModule, AuthModule, PrismaModule],
  controllers: [SubscriptionsController, InternalSubscriptionsController],
  providers: [SubscriptionsService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
