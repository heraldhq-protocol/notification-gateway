import { Module, Global } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SandboxService } from './sandbox.service';
import { SandboxController } from './sandbox.controller';
import { QueueModule } from '../queue/queue.module';

@Global()
@Module({
  imports: [ScheduleModule.forRoot(), QueueModule],
  controllers: [SandboxController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
