import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { Request, Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { createHash } from 'crypto';

const SENSITIVE_KEYS = new Set([
  'wallet', 'email', 'subject', 'body', 'authorization', 'password', 'secret',
]);

function sanitizeBody(obj: unknown): unknown {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeBody);
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? '[redacted]' : sanitizeBody(v);
  }
  return result;
}

@Injectable()
export class RequestLogInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<
      Request & { authProtocol?: { protocolId: string; apiKeyId?: string; isTestKey?: boolean }; correlationId?: string }
    >();
    const res = ctx.switchToHttp().getResponse<Response>();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: (responseBody) => {
          const protocol = req.authProtocol;
          if (!protocol?.protocolId) return;

          const latencyMs = Date.now() - start;
          const ip = req.headers['x-forwarded-for'] as string | undefined ?? req.socket.remoteAddress ?? '';
          const ipHash = ip ? createHash('sha256').update(ip).digest('hex').slice(0, 16) : null;

          this.prisma.apiRequestLog.create({
            data: {
              protocolId: protocol.protocolId,
              apiKeyId: protocol.apiKeyId && protocol.apiKeyId !== 'internal' ? protocol.apiKeyId : null,
              isTestKey: protocol.isTestKey ?? false,
              method: req.method,
              endpoint: req.path,
              requestBody: sanitizeBody(req.body) as any,
              responseBody: sanitizeBody(responseBody) as any,
              statusCode: res.statusCode,
              latencyMs,
              correlationId: req.correlationId ?? null,
              ipHash,
            },
          }).catch(() => {
            // Fire-and-forget — never block response
          });
        },
        error: (err) => {
          const protocol = req.authProtocol;
          if (!protocol?.protocolId) return;

          const latencyMs = Date.now() - start;
          this.prisma.apiRequestLog.create({
            data: {
              protocolId: protocol.protocolId,
              apiKeyId: protocol.apiKeyId && protocol.apiKeyId !== 'internal' ? protocol.apiKeyId : null,
              isTestKey: protocol.isTestKey ?? false,
              method: req.method,
              endpoint: req.path,
              requestBody: sanitizeBody(req.body) as any,
              statusCode: err?.status ?? 500,
              latencyMs,
              correlationId: req.correlationId ?? null,
            },
          }).catch(() => {});
        },
      }),
    );
  }
}
