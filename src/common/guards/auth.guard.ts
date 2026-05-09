import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { AuthService } from '../../modules/auth/auth.service';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedProtocol } from '../types/protocol.types';

/**
 * AuthGuard — validates the Bearer API key on every protected route.
 *
 * Flow:
 *   1. Check for internal service bypass (herald-admin → /domains/*)
 *   2. Extract Bearer token from Authorization header
 *   3. Call AuthService.validateApiKey (hash → Redis → PG)
 *   4. Attach authenticated protocol to request.authProtocol
 *   5. Reject with 401 if invalid
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { authProtocol: AuthenticatedProtocol }>();

    // Internal service bypass for /domains/* and /templates/* endpoints
    const internalKey = this.config.get('INTERNAL_API_KEY');
    if (internalKey) {
      const isInternalRequest =
        request.headers['x-internal-service'] === 'herald-admin' &&
        request.headers['x-internal-key'] === internalKey;

      const isDomainPath = request.url.startsWith('/v1/domains');
      const isTemplatePath = request.url.startsWith('/v1/templates');

      if (isInternalRequest && (isDomainPath || isTemplatePath)) {
        const protocolId = request.headers['x-protocol-id'] as string;
        if (!protocolId) {
          throw new UnauthorizedException(
            'Missing x-protocol-id for internal request',
          );
        }

        const protocol = await this.prisma.protocol.findUnique({
          where: { id: protocolId },
          select: {
            id: true,
            protocolPubkey: true,
            tier: true,
            isActive: true,
          },
        });
        if (!protocol) {
          throw new UnauthorizedException('Invalid protocolId');
        }

        (request as any).authProtocol = {
          protocolId: protocol.id,
          protocolPubkey: protocol.protocolPubkey,
          tier: protocol.tier,
          isActive: protocol.isActive,
          apiKeyId: 'internal',
          scopes: ['notify:write', 'notify:read', 'admin'],
          environment: 'production',
        };
        return true;
      }
    }

    // Standard API key authentication
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
