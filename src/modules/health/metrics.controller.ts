import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import type { Response } from 'express';

@ApiTags('Health')
@Controller('metrics')
export class MetricsController extends PrometheusController {
  @Get()
  @ApiOperation({ summary: 'Prometheus metrics' })
  async index(@Res({ passthrough: true }) response: Response) {
    return super.index(response);
  }
}
