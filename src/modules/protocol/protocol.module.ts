import { Module } from '@nestjs/common';
import { ProtocolController } from './protocol.controller';
import { PortalProtocolsController } from './portal-protocols.controller';
import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../../database/prisma.module';
import { PortalAuthGuard } from '../../common/guards/portal-auth.guard';
import { ProtocolService } from './protocol.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [ProtocolController, PortalProtocolsController],
  providers: [ProtocolService, PortalAuthGuard],
  exports: [ProtocolService],
})
export class ProtocolModule {}
