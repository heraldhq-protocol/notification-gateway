import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';
import { PublicKey } from '@solana/web3.js';

/**
 * SolanaPubkeyPipe — validates that a string parameter is
 * a valid Solana base58 public key (32 bytes).
 *
 * Usage: @Param('wallet', SolanaPubkeyPipe) wallet: string
 */
@Injectable()
export class SolanaPubkeyPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    try {
      const pubkey = new PublicKey(value);
      // Verify it encodes to exactly the same string (prevents padding attacks)
      if (pubkey.toBase58() !== value) {
        throw new Error('Pubkey mismatch after re-encoding');
      }
      return value;
    } catch {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Invalid Solana public key: "${value?.substring(0, 10)}..."`,
      });
    }
  }
}
