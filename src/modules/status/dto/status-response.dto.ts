import { ApiProperty } from '@nestjs/swagger';

export class StatusResponseDto {
  @ApiProperty({ example: 'operational' })
  overallStatus: 'operational' | 'degraded' | 'major_outage';

  @ApiProperty({ example: 0 })
  activeIncidents: number;

  @ApiProperty({
    example: {
      database: 'ok',
      redis: 'ok',
      email: 'ok',
      webhooks: 'ok',
    },
  })
  services: Record<string, 'ok' | 'error'>;

  @ApiProperty({ example: '2026-04-27T12:00:00.000Z' })
  lastUpdated: string;
}
