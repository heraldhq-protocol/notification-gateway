import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import type { AuthenticatedProtocol } from '../types/protocol.types';

/**
 * AuthGuard — validates the Bearer API key on every protected route.
 *
 * Flow:
 *   1. Extract Bearer token from Authorization header
 *   2. Call AuthService.validateApiKey (hash → Redis → PG)
 *   3. Attach authenticated protocol to request.authProtocol
 *   4. Reject with 401 if invalid
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { authProtocol: AuthenticatedProtocol }>();

    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException({
        error: 'AUTH_INVALID_KEY',
        message:
          'Authorization header missing or malformed. Expected: Bearer hrld_xxx',
      });
    }

    const plainTextKey = authHeader.substring(7);
    const protocol = await this.authService.validateApiKey(plainTextKey);

    if (!protocol) {
      throw new UnauthorizedException({
        error: 'AUTH_INVALID_KEY',
        message: 'Invalid or revoked API key',
      });
    }

    (request as any).authProtocol = protocol;
    return true;
  }
}
