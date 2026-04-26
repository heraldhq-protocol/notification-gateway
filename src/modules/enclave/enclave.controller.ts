import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { EnclaveService } from './enclave.service';
import { InternalGuard } from '../../common/guards/internal.guard';
import {
  EncryptNotificationDto,
  EncryptNotificationResponseDto,
} from './dto/encrypt-notification.dto';

/**
 * EnclaveController — internal-only endpoints for notification encryption.
 *
 * All routes are protected by InternalGuard (x-internal-secret header).
 * These endpoints are called by the notification worker, NOT by external clients.
 */
@ApiTags('Enclave')
@ApiBearerAuth()
@Controller('enclave')
@UseGuards(InternalGuard)
export class EnclaveController {
  private readonly logger = new Logger(EnclaveController.name);

  constructor(private readonly enclave: EnclaveService) {}

  /**
   * POST /enclave/encrypt
   *
   * Encrypts a notification payload for a specific recipient wallet.
   * Returns the NaCl box ciphertext and nonce, or { encrypted: false }
   * if the recipient has no notification key.
   */
  @Post('encrypt')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Encrypt a notification for a recipient',
    description:
      'Unseals the recipient X25519 key from on-chain, encrypts the payload via NaCl box.',
  })
  @ApiResponse({ status: 200, type: EncryptNotificationResponseDto })
  @ApiResponse({ status: 401, description: 'Invalid internal credentials' })
  async encrypt(
    @Body() dto: EncryptNotificationDto,
  ): Promise<EncryptNotificationResponseDto> {
    const result = await this.enclave.encryptForRecipient(dto.recipientWallet, {
      subject: dto.subject,
      message: dto.message,
      actionUrl: dto.actionUrl,
      metadata: dto.metadata,
    });

    if (!result) {
      // No notification key or enclave not ready — return unencrypted flag
      return {
        ciphertext: '',
        nonce: '',
        encrypted: false,
      };
    }

    return {
      ciphertext: Buffer.from(result.ciphertext).toString('hex'),
      nonce: Buffer.from(result.nonce).toString('hex'),
      encrypted: true,
    };
  }

  /**
   * GET /enclave/status
   *
   * Returns whether the enclave is ready (keypair loaded) and its public key.
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check enclave readiness',
    description:
      'Returns whether the enclave keypair is loaded and operational.',
  })
  status(): {
    ready: boolean;
    publicKey: string | null;
  } {
    const pubkey = this.enclave.getPublicKey();
    return {
      ready: this.enclave.isReady(),
      publicKey: pubkey ? Buffer.from(pubkey).toString('hex') : null,
    };
  }
}
