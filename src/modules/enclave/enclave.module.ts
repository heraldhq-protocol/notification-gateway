import { Module } from '@nestjs/common';
import { EnclaveService } from './enclave.service';
import { EnclaveController } from './enclave.controller';
import { SolanaModule } from '../../solana/solana.module';

/**
 * EnclaveModule — Herald's notification encryption enclave.
 *
 * Provides:
 * - EnclaveService: unsealing + NaCl box encryption
 * - EnclaveController: internal-only HTTP endpoints
 *
 * Depends on:
 * - SolanaModule: for reading IdentityAccount PDAs
 * - ConfigModule: for HERALD_X25519_PRIV_HEX (global)
 */
@Module({
  imports: [SolanaModule],
  controllers: [EnclaveController],
  providers: [EnclaveService],
  exports: [EnclaveService],
})
export class EnclaveModule {}
