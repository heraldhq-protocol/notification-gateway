import {
  Controller,
  Get,
  Param,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { RoutingService } from './routing.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

@ApiTags('Wallets')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/wallets')
export class WalletController {
  constructor(private readonly routingService: RoutingService) {}

  @Get(':wallet/status')
  @ApiOperation({ summary: 'Check if a wallet is registered in Herald' })
  @ApiParam({ name: 'wallet', description: 'Base58 Solana wallet address' })
  async getWalletStatus(
    @Param('wallet') wallet: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const pda = await this.routingService.findPDAForWallet(
      protocol.protocolPubkey,
      wallet,
    );

    if (!pda) {
      throw new NotFoundException({
        registered: false,
        message: 'Wallet not found or not opted into this protocol',
      });
    }

    return {
      registered: true,
      wallet,
      protocolId: protocol.protocolId,
      // Provide basic info but NEVER expose the raw PDA state or ciphertexts here
    };
  }
}
