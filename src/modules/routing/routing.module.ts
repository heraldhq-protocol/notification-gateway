import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { EnclaveService } from './enclave.service';
import { SolanaModule } from '../../solana/solana.module';

@Module({
  imports: [SolanaModule],
  providers: [RoutingService, EnclaveService],
  exports: [RoutingService, EnclaveService],
})
export class RoutingModule { }
