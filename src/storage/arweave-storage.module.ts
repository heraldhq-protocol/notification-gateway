import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ArweaveStorageService } from './arweave-storage.service';

@Module({
  imports: [ConfigModule],
  providers: [ArweaveStorageService],
  exports: [ArweaveStorageService],
})
export class ArweaveStorageModule {}
