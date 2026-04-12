import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { RateLimitService } from '../../modules/auth/rate-limit.service';
import type { AuthenticatedProtocol } from '../types/protocol.types';

/**
 * RateLimitInterceptor — applies tiered rate limiting and attaches quota headers.
 *
 * Applied globally to notify endpoints. Executes BEFORE the route handler
 * to enforce limits, and AFTER to attach quota headers to successful responses.
 *
 * Headers attached to every response:
 *   X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
 *   X-Herald-Quota-Used, X-Herald-Quota-Limit, X-Herald-Quota-Remaining
 *   X-Herald-Environment, X-Correlation-Id
 */
@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly rateLimitService: RateLimitService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const protocol: AuthenticatedProtocol | undefined = request.protocol;

    // Only apply to authenticated requests
    if (!protocol) {
      return next.handle();
    }

    // Determine if this is a batch request
    const isBatch = request.url?.includes('/batch') ?? false;
    const batchCount = isBatch ? (request.body?.notifications?.length ?? 1) : 1;

    const result = await this.rateLimitService.checkAllLimits(
      protocol,
      isBatch,
      batchCount,
    );

    // Always attach rate limit headers
    Object.entries(result.headers).forEach(([key, value]) => {
      response.setHeader(key, value);
    });

    // Add correlation ID for tracing
    const correlationId =
      request.headers['x-request-id'] ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    response.setHeader('X-Correlation-Id', correlationId);

    if (!result.allowed) {
      const body: Record<string, unknown> = {
        error: result.error,
        message: result.message,
        statusCode: result.httpStatus ?? 429,
      };

      if (result.retryAfter) {
        body.retryAfter = result.retryAfter;
      }

      throw new HttpException(
        body,
        result.httpStatus ?? HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return next.handle().pipe(
      tap(() => {
        // Re-apply headers after handler (some frameworks reset them)
        Object.entries(result.headers).forEach(([key, value]) => {
          response.setHeader(key, value);
        });
      }),
    );
  }
}
