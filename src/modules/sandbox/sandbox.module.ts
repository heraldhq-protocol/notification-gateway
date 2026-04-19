import { Module, Global } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SandboxService } from './sandbox.service';

@Global()
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
