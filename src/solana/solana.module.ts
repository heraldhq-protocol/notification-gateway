import { Module } from '@nestjs/common';
import { SolanaService } from './solana.service';
import { RpcManagerService } from './rpc-manager.service';

@Module({
  providers: [SolanaService, RpcManagerService],
  exports: [SolanaService, RpcManagerService],
})
export class SolanaModule { }
