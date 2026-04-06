import { Controller, Get, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProtocolService } from './protocol.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

/**
 * ProtocolController — protocol self-service endpoints.
 */
@ApiTags('Protocol')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/protocols')
@RequiredScopes('protocol:read')
export class ProtocolController {
  constructor(private readonly protocolService: ProtocolService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get your protocol info + subscription status' })
  async getMe(@ApiKey() protocol: AuthenticatedProtocol) {
    const info = await this.protocolService.getProtocolInfo(
      protocol.protocolId,
    );
    if (!info) throw new NotFoundException('Protocol not found');
    return info;
  }
}
