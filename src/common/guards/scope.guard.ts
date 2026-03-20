import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedProtocol } from '../types/protocol.types.js';

export const SCOPES_KEY = 'scopes';

/**
 * Decorator to declare required scopes on a route handler.
 * Usage: @RequiredScopes('notify:write', 'webhook:manage')
 */
export const RequiredScopes = (...scopes: string[]) =>
  SetMetadata(SCOPES_KEY, scopes);

/**
 * ScopeGuard — enforces permission scope requirements.
 * Checks that the protocol's API key has the required scopes.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(
      SCOPES_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );

    if (!requiredScopes || requiredScopes.length === 0) return true;

    const request = ctx.switchToHttp().getRequest();
    const protocol = request.protocol as AuthenticatedProtocol;

    if (!protocol) {
      throw new ForbiddenException({
        error: 'AUTH_INSUFFICIENT_SCOPE',
        message: 'No authenticated protocol context',
      });
    }

    const hasAll = requiredScopes.every((scope) =>
      protocol.scopes.includes(scope),
    );

    if (!hasAll) {
      throw new ForbiddenException({
        error: 'AUTH_INSUFFICIENT_SCOPE',
        message: `Required scopes: ${requiredScopes.join(', ')}`,
      });
    }

    return true;
  }
}
