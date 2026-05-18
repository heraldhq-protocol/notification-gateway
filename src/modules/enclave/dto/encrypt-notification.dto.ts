import { IsNotEmpty, IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * DTO for the POST /enclave/encrypt endpoint.
 *
 * Receives a notification payload and a recipient wallet pubkey.
 * The enclave service unseals the recipient's X25519 key from on-chain,
 * performs ECDH with the enclave's private key, and returns the encrypted payload.
 */
export class EncryptNotificationDto {
  @ApiProperty({
    description: 'Base58 pubkey of the recipient wallet',
    example: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  })
  @IsNotEmpty()
  @IsString()
  recipientWallet: string;

  @ApiProperty({
    description: 'Notification subject/title',
    example: 'Your LP position is at risk',
  })
  @IsNotEmpty()
  @IsString()
  subject: string;

  @ApiProperty({
    description: 'Notification message body',
    example:
      'Your USDC/SOL position on Raydium has dropped below the liquidation threshold.',
  })
  @IsNotEmpty()
  @IsString()
  message: string;

  @ApiPropertyOptional({
    description: 'Optional call-to-action URL',
    example: 'https://raydium.io/liquidity/?pair=USDC-SOL',
  })
  @IsOptional()
  @IsString()
  actionUrl?: string;

  @ApiPropertyOptional({
    description:
      'Optional key-value metadata to include in the encrypted payload',
    example: { poolId: 'abc123', severity: 'critical' },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

/**
 * Response shape for the encrypt endpoint.
 */
export class EncryptNotificationResponseDto {
  @ApiProperty({ description: 'NaCl box ciphertext, hex-encoded' })
  ciphertext: string;

  @ApiProperty({ description: 'NaCl box nonce, hex-encoded (24 bytes)' })
  nonce: string;

  @ApiProperty({
    description: 'Whether the recipient has a registered notification key',
  })
  encrypted: boolean;
}
