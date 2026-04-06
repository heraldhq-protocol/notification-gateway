import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import { AdminService } from './admin.service';
import { BroadcastDto } from './dto/broadcast.dto';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /**
   * POST /v1/admin/broadcast — Send a system message to ALL users.
   * Restricted to Herald Admin (system) with `admin:broadcast` scope.
   */
  @Post('broadcast')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequiredScopes('admin:broadcast')
  @ApiOperation({
    summary: 'Broadcast system message to all users',
    description:
      'Fetches all registered users from Solana and enqueues notifications.',
  })
  @ApiResponse({ status: 202, description: 'Broadcast enqueued' })
  @ApiResponse({ status: 403, description: 'Insufficient scope' })
  async broadcast(
    @Body() dto: BroadcastDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.adminService.broadcast(dto, protocol);
  }
}
