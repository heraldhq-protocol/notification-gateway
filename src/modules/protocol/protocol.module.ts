import { Module } from '@nestjs/common';
import { ProtocolController } from './protocol.controller';
import { AuthModule } from '../auth/auth.module';
import { ProtocolService } from './protocol.service';

@Module({
  imports: [AuthModule],
  controllers: [ProtocolController],
  providers: [ProtocolService],
  exports: [ProtocolService],
})
export class ProtocolModule { }
