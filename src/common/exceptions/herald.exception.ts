import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Base exception for all Herald-specific errors.
 * Includes a machine-readable error code for client consumption.
 */
export class HeraldException extends HttpException {
  public readonly errorCode: string;

  constructor(
    errorCode: string,
    message: string,
    status: HttpStatus = HttpStatus.INTERNAL_SERVER_ERROR,
  ) {
    super({ error: errorCode, message }, status);
    this.errorCode = errorCode;
  }
}

/**
 * 404 — Wallet not registered in Herald Privacy Registry.
 */
export class WalletNotRegisteredException extends HeraldException {
  constructor() {
    super(
      'WALLET_NOT_REGISTERED',
      'No Herald identity found for this wallet',
      HttpStatus.NOT_FOUND,
    );
  }
}

/**
 * 429 — Rate limit exceeded for protocol tier.
 */
export class RateLimitExceededException extends HeraldException {
  public readonly retryAfter: number;

  constructor(retryAfter: number = 1) {
    super(
      'RATE_LIMIT_EXCEEDED',
      `Rate limit exceeded. Retry after ${retryAfter}s`,
      HttpStatus.TOO_MANY_REQUESTS,
    );
    this.retryAfter = retryAfter;
  }
}

/**
 * 503 — Routing/enclave service unavailable.
 */
export class RoutingUnavailableException extends HeraldException {
  constructor() {
    super(
      'ROUTING_UNAVAILABLE',
      'Email routing service temporarily unavailable',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}

/**
 * 503 — Solana registry unavailable.
 */
export class RegistryUnavailableException extends HeraldException {
  constructor() {
    super(
      'REGISTRY_UNAVAILABLE',
      'Solana registry temporarily unavailable',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
