import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SESClient, VerifyEmailIdentityCommand } from '@aws-sdk/client-ses';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

const VERIFIED_PREFIX = 'ses:verified:';
const BACKOFF_PREFIX = 'ses:verify:backoff:';
const VERIFIED_TTL = 3_600;
const BACKOFF_TTL = 300;

@Injectable()
export class SesIdentityService {
  private readonly logger = new Logger(SesIdentityService.name);
  private readonly client: SESClient;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    this.enabled =
      this.config.get<boolean>('SES_AUTO_VERIFY_IDENTITIES', false) &&
      this.config.get('MAIL_PROVIDER') === 'ses';

    this.client = new SESClient({
      region: this.config.get('SES_REGION', 'us-east-1'),
      maxAttempts: 2,
    });
  }

  async ensureVerified(email: string): Promise<void> {
    if (!this.enabled) return;

    try {
      if (await this.redis.get(`${VERIFIED_PREFIX}${email}`)) return;

      if (await this.redis.get(`${BACKOFF_PREFIX}${email}`)) return;

      await this.client.send(
        new VerifyEmailIdentityCommand({ EmailAddress: email }),
      );

      await this.redis.setex(`${VERIFIED_PREFIX}${email}`, VERIFIED_TTL, '1');

      this.logger.debug('SES identity verification submitted', {
        email: this.mask(email),
      });
    } catch (err: any) {
      if (err.name === 'AlreadyExistsException') {
        await this.redis.setex(`${VERIFIED_PREFIX}${email}`, VERIFIED_TTL, '1');
        return;
      }

      if (err.name === 'LimitExceededException' || err.name === 'Throttling') {
        await this.redis.setex(`${BACKOFF_PREFIX}${email}`, BACKOFF_TTL, '1');
      }

      this.logger.warn('SES identity verification failed (non-blocking)', {
        email: this.mask(email),
        error: err.message,
        code: err.name,
      });
    }
  }

  private mask(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '<invalid>';
    return `${local[0]}***@${domain}`;
  }
}
