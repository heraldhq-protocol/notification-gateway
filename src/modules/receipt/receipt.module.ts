import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { QueueNames } from '../queue/queue.constants';
import { ReceiptService } from './receipt.service';
import { LightClientService } from './light-client.service';
import { ReceiptWorker } from './receipt.worker';
import { SolanaModule } from '../../solana/solana.module';

@Module({
  imports: [
    ConfigModule,
    ScheduleModule.forRoot(),
    SolanaModule,
    BullModule.registerQueue({
      name: QueueNames.RECEIPT_BATCH,
    }),
  ],
  providers: [
    ReceiptService,
    LightClientService,
    ReceiptWorker,
    {
      provide: 'LIGHT_ENV',
      useFactory: (config: ConfigService) => {
        const rpcUrl = config.get<string>('SOLANA_RPC_URL', '');
        return rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')
          ? 'local'
          : 'remote';
      },
      inject: [ConfigService],
    },
  ],
  exports: [ReceiptService],
})
export class ReceiptModule {}
