import { Module } from '@nestjs/common';
import { ProtocolController } from './protocol.controller.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports: [AuthModule],
  controllers: [ProtocolController],
})
export class ProtocolModule {}
