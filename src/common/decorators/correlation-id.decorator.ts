import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * @CorrelationId() parameter decorator — extracts the correlation ID
 * injected by the LoggingInterceptor.
 */
export const CorrelationId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest();
    return request.correlationId as string;
  },
);
