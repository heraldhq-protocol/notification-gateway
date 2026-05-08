import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { StatusService } from './status.service';
import { StatusResponseDto } from './dto/status-response.dto';

@ApiTags('System')
@Controller('status')
export class StatusController {
  constructor(private readonly statusService: StatusService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get overall system status' })
  @ApiResponse({ status: 200, type: StatusResponseDto })
  async getSystemStatus(): Promise<StatusResponseDto> {
    return this.statusService.getSystemStatus();
  }
}
