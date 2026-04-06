import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedProtocol } from '../types/protocol.types';

/**
 * @ApiKey() parameter decorator — extracts the authenticated protocol
 * from the request object (set by AuthGuard).
 *
 * Usage:
 *   @Post('notify')
 *   async notify(@ApiKey() protocol: AuthenticatedProtocol) { ... }
 */
export const ApiKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedProtocol => {
    const request = ctx.switchToHttp().getRequest();
    return request.authProtocol as AuthenticatedProtocol;
  },
);
