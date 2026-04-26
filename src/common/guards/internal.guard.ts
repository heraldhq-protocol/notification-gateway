import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedProtocol } from '../types/protocol.types';

@Injectable()
export class InternalGuard implements CanActivate {
  constructor(@Inject(ConfigService) private config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { authProtocol: AuthenticatedProtocol }>();

    const internalSecret = this.config.get('INTERNAL_API_KEY');
    const providedSecret = request.headers['x-internal-secret'];

    if (!internalSecret || internalSecret !== providedSecret) {
      throw new UnauthorizedException({
        error: 'INVALID_INTERNAL_REQUEST',
        message: 'Invalid internal service credentials',
      });
    }

    const protocolId = request.headers['x-protocol-id'];
    if (!protocolId) {
      throw new UnauthorizedException({
        error: 'MISSING_PROTOCOL_ID',
        message: 'x-protocol-id header required',
      });
    }

    (request as any).authProtocol = { protocolId: protocolId as string };
    return true;
  }
}
