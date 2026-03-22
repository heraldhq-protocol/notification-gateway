import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { HeraldException } from './herald.exception';

/**
 * Global exception filter — converts all exceptions to structured JSON.
 *
 * Response format:
 * {
 *   error:         "ERROR_CODE",
 *   message:       "Human-readable message",
 *   statusCode:    400,
 *   correlationId: "01HXYZ..."
 * }
 *
 * SECURITY: Never exposes stack traces or internal details in production.
 */
@Catch()
export class HeraldExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HeraldExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const correlationId = (request as unknown as Record<string, unknown>)
      .correlationId as string | undefined;

    let status: number;
    let errorCode: string;
    let message: string;
    let details: Record<string, unknown> | undefined;

    if (exception instanceof HeraldException) {
      status = exception.getStatus();
      errorCode = exception.errorCode;
      message = (exception.getResponse() as Record<string, string>).message;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const obj = res as Record<string, unknown>;
        errorCode = (obj.error as string) ?? 'HTTP_ERROR';
        message = Array.isArray(obj.message)
          ? obj.message.join(', ')
          : ((obj.message as string) ?? exception.message);
        // class-validator details
        if (Array.isArray(obj.message) && obj.message.length > 0) {
          details = { validation: obj.message };
        }
      } else {
        errorCode = 'HTTP_ERROR';
        message = typeof res === 'string' ? res : exception.message;
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      errorCode = 'INTERNAL_ERROR';
      message =
        process.env.NODE_ENV === 'production'
          ? 'An unexpected error occurred'
          : exception instanceof Error
            ? exception.message
            : 'Unknown error';

      // Log the full error for internal debugging
      this.logger.error(
        'Unhandled exception',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const body: Record<string, unknown> = {
      error: errorCode,
      message,
      statusCode: status,
    };

    if (correlationId) body.correlationId = correlationId;
    if (details) body.details = details;

    response.status(status).json(body);
  }
}
