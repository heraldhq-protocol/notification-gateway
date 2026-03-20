import { Module } from '@nestjs/common';
import { ProtocolController } from './protocol.controller.js';
import { AuthModule } from '../auth/auth.module.js';
import { ProtocolService } from './protocol.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ProtocolController],
  providers: [ProtocolService],
  exports: [ProtocolService],
})
export class ProtocolModule { }
