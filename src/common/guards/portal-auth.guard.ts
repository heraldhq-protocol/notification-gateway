import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';

/**
 * PortalAuthGuard — authenticates requests from the herald-user-portal.
 *
 * Strategy: decode the JWT payload (no signature verification — @nestjs/jwt
 * is not a gateway dependency), extract `jti`, then validate against the
 * `PortalSession` table. The DB row is the source of truth for revocation
 * and expiry, making this equivalent to token introspection.
 *
 * Attaches `request.walletHash` (from DB, not from the untrusted payload).
 */
@Injectable()
export class PortalAuthGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const request = ctx.switchToHttp().getRequest<Request>();
    const raw = this.extractBearer(request);
    if (!raw) throw new UnauthorizedException('Missing portal token');

    let jti: string;
    try {
      const payload = JSON.parse(
        Buffer.from(raw.split('.')[1], 'base64url').toString('utf-8'),
      ) as { type?: string; jti?: string; sub?: string };

      if (payload.type !== 'portal' || !payload.jti) {
        throw new Error('invalid type or missing jti');
      }
      jti = payload.jti;
    } catch {
      throw new UnauthorizedException('Invalid portal token');
    }

    const session = await this.prisma.portalSession.findUnique({
      where: { jwtJti: jti },
    });

    if (!session || session.revoked || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Portal session expired or revoked');
    }

    (request as Request & { walletHash: string }).walletHash =
      session.walletHash;
    return true;
  }

  private extractBearer(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
