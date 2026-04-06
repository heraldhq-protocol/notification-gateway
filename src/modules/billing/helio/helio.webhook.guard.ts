import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { HelioService } from './helio.service';
import { PinoLogger } from 'nestjs-pino';

// Define the rawBody interface since it depends on express/body-parser setup
export interface RequestWithRawBody extends Request {
  rawBody: Buffer;
}

@Injectable()
export class HelioWebhookGuard implements CanActivate {
  constructor(
    private readonly helioService: HelioService,
    private readonly logger: PinoLogger,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const request = ctx.switchToHttp().getRequest<RequestWithRawBody>();
    const signature = request.headers['x-helio-signature'] as string;

    if (!signature) {
      throw new UnauthorizedException('Missing X-Helio-Signature header');
    }

    if (!request.rawBody) {
      this.logger.warn('Webhook request missing rawBody');
      throw new UnauthorizedException('Missing request raw body');
    }

    // Pass the raw string to parseAndVerifyWebhook
    const rawBodyString = request.rawBody.toString('utf8');
    const isValid = this.helioService.parseAndVerifyWebhook(
      rawBodyString,
      signature,
    );

    if (!isValid) {
      this.logger.warn('Invalid Helio webhook signature rejected');
      throw new UnauthorizedException('Invalid webhook signature');
    }

    return true;
  }
}
