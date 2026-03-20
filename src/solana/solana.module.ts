import { Module } from '@nestjs/common';
import { SolanaService } from './solana.service.js';
import { RpcManagerService } from './rpc-manager.service.js';

@Module({
  providers: [SolanaService, RpcManagerService],
  exports: [SolanaService, RpcManagerService],
})
export class SolanaModule {}
