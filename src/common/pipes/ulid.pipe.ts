import { PipeTransform, Injectable, BadRequestException } from '@nestjs/common';

/**
 * UlidPipe — validates that a string parameter is a valid ULID.
 * ULIDs are 26-character Crockford base32 strings.
 */
@Injectable()
export class UlidPipe implements PipeTransform<string, string> {
  private static readonly ULID_REGEX = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

  transform(value: string): string {
    if (!UlidPipe.ULID_REGEX.test(value)) {
      throw new BadRequestException({
        error: 'VALIDATION_ERROR',
        message: `Invalid ULID: "${value?.substring(0, 10)}..."`,
      });
    }
    return value;
  }
}
