import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Standard API error response format for all Herald endpoints.
 */
export class ApiErrorResponseDto {
  @ApiProperty({
    description: 'Machine-readable error code',
    example: 'AUTH_INVALID_KEY',
  })
  error: string;

  @ApiProperty({
    description: 'Human-readable message',
    example: 'Invalid or revoked API key',
  })
  message: string;

  @ApiPropertyOptional({ description: 'Field-level validation errors' })
  details?: Record<string, string[]>;

  @ApiPropertyOptional({ description: 'Correlation ID for log tracing' })
  correlationId?: string;
}

/**
 * Standard success response wrapper.
 */
export class ApiSuccessResponseDto<T> {
  @ApiProperty({ description: 'Response data' })
  data: T;

  @ApiPropertyOptional({ description: 'Correlation ID for log tracing' })
  correlationId?: string;
}
