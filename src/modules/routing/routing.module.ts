import { Module } from '@nestjs/common';
import { RoutingService } from './routing.service';
import { EnclaveService } from './enclave.service';
import { SandboxRoutingService } from './sandbox-routing.service';
import { SolanaModule } from '../../solana/solana.module';
import { WalletController } from './wallet.controller';
import { AuthModule } from '../auth/auth.module';
import { SandboxModule } from '../sandbox/sandbox.module';

@Module({
  imports: [SolanaModule, AuthModule, SandboxModule],
  controllers: [WalletController],
  providers: [RoutingService, EnclaveService, SandboxRoutingService],
  exports: [RoutingService, EnclaveService, SandboxRoutingService],
})
export class RoutingModule {}
