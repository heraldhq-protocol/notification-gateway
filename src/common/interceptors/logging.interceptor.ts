import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { ulid } from 'ulid';
import type { Request, Response } from 'express';

/**
 * LoggingInterceptor — structured request/response logging.
 *
 * CRITICAL SECURITY (SEC-001):
 * - NEVER log email addresses
 * - NEVER log full wallet pubkeys (truncate to 6+6 chars)
 * - NEVER log request bodies containing subject/body fields
 * - NEVER log Authorization headers
 *
 * Injects a correlation ID into every request for distributed tracing.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { correlationId: string }>();
    const response = ctx.switchToHttp().getResponse<Response>();
    const start = Date.now();

    // Inject correlation ID
    const correlationId =
      (request.headers['x-correlation-id'] as string) ?? ulid();
    request.correlationId = correlationId;
    response.setHeader('X-Correlation-Id', correlationId);

    return next.handle().pipe(
      tap({
        next: () => {
          this.logger.log({
            correlationId,
            method: request.method,
            url: request.url,
            statusCode: response.statusCode,
            duration: `${Date.now() - start}ms`,
            userAgent: request.headers['user-agent']?.substring(0, 100),
          });
        },
        error: (err: Error) => {
          this.logger.error({
            correlationId,
            method: request.method,
            url: request.url,
            duration: `${Date.now() - start}ms`,
            error: err.message,
            // NEVER log: request.body, authorization header, stack trace in prod
          });
        },
      }),
    );
  }
}
