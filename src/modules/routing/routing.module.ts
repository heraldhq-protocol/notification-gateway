import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service.js';
import { EnclaveService } from './enclave.service.js';
import { SolanaModule } from '../../solana/solana.module.js';

@Module({
  imports: [SolanaModule],
  providers: [RoutingService, EnclaveService],
  exports: [RoutingService, EnclaveService],
})
export class RoutingModule {}
