import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { EnclaveService } from './enclave.service';
import { SolanaModule } from '../../solana/solana.module';
import { WalletController } from './wallet.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [SolanaModule, AuthModule],
  controllers: [WalletController],
  providers: [RoutingService, EnclaveService],
  exports: [RoutingService, EnclaveService],
})
export class RoutingModule {}
