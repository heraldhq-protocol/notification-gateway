import { Module, Global } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SandboxService } from './sandbox.service';
import { SandboxController } from './sandbox.controller';
import { QueueModule } from '../queue/queue.module';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [ScheduleModule.forRoot(), QueueModule, AuthModule],
  controllers: [SandboxController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
