import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Response } from 'express';

/**
 * ResponseTimeInterceptor — adds X-Response-Time header to every response.
 * Used for observability and performance monitoring.
 */
@Injectable()
export class ResponseTimeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const start = Date.now();
    const response = ctx.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      tap(() => {
        response.setHeader('X-Response-Time', `${Date.now() - start}ms`);
      }),
    );
  }
}
