import { Controller, Get, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProtocolService } from './protocol.service.js';
import { AuthGuard } from '../../common/guards/auth.guard.js';
import { ApiKey } from '../../common/decorators/api-key.decorator.js';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types.js';

/**
 * ProtocolController — protocol self-service endpoints.
 */
@ApiTags('Protocol')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/protocols')
export class ProtocolController {
  constructor(private readonly protocolService: ProtocolService) { }

  @Get('me')
  @ApiOperation({ summary: 'Get your protocol info + subscription status' })
  async getMe(@ApiKey() protocol: AuthenticatedProtocol) {
    const info = await this.protocolService.getProtocolInfo(protocol.protocolId);
    if (!info) throw new NotFoundException('Protocol not found');
    return info;
  }
}
