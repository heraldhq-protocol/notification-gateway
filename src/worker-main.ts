import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));

  process.on('SIGTERM', () => {
    console.log('Worker received SIGTERM — shutting down gracefully');
    void app.close().then(() => process.exit(0));
  });

  console.log('Herald Worker started — listening for BullMQ jobs');
}

bootstrap().catch((err) => {
  console.error('Failed to start worker:', err);
  process.exit(1);
});
