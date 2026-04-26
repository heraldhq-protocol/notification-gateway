import {
  Controller,
  Delete,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { InternalGuard } from '../../common/guards/internal.guard';

@ApiTags('Auth Internal')
@UseGuards(InternalGuard)
@Controller('internal/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Delete('cache/:keyHash')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Invalidate API key cache (Internal Admin Only)' })
  @ApiParam({
    name: 'keyHash',
    description: 'SHA-256 hash of the API key to invalidate',
  })
  async invalidateCache(@Param('keyHash') keyHash: string): Promise<void> {
    await this.authService.invalidateCache(keyHash);
  }
}
