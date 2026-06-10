import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { UnsubscribeService } from './unsubscribe.service';

/**
 * PortalUnsubscribeController — JSON unsubscribe API consumed by the
 * herald-user-portal Next.js app at notify.useherald.xyz/unsubscribe/[token].
 *
 * Distinct from UnsubscribeController (which renders HTML pages for email
 * clients). This controller returns JSON so the portal can render its own UI.
 *
 * No authentication required — the HMAC token in the URL is the auth mechanism.
 */
@ApiTags('Portal')
@Controller('v1/portal/unsubscribe')
export class PortalUnsubscribeController {
  constructor(private readonly unsubscribeService: UnsubscribeService) {}

  /**
   * GET /v1/portal/unsubscribe/:token
   * Validates the token and returns the category to display on the confirmation UI.
   */
  @Get(':token')
  @ApiOperation({ summary: 'Preview unsubscribe action (portal)' })
  @ApiParam({ name: 'token', description: 'HMAC-signed unsubscribe token' })
  @ApiResponse({ status: 200, description: 'Token valid — preview data returned' })
  @ApiResponse({ status: 404, description: 'Invalid or expired token' })
  getPreview(@Param('token') token: string) {
    const payload = this.unsubscribeService.decodeToken(token);
    if (!payload) {
      throw new NotFoundException('Invalid or expired unsubscribe link.');
    }
    return {
      valid: true,
      category: payload.category ?? null,
    };
  }

  /**
   * POST /v1/portal/unsubscribe/:token
   * Executes the unsubscribe action and returns a success response.
   */
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute unsubscribe action (portal)' })
  @ApiParam({ name: 'token', description: 'HMAC-signed unsubscribe token' })
  @ApiResponse({ status: 200, description: 'Successfully unsubscribed' })
  @ApiResponse({ status: 400, description: 'Invalid, expired, or already-used token' })
  async executeUnsubscribe(@Param('token') token: string) {
    const result = await this.unsubscribeService.validateAndExecute(token);
    if (!result.success) {
      throw new BadRequestException(
        result.error || 'Failed to process unsubscribe request.',
      );
    }
    return { success: true, alreadyOptedOut: false };
  }
}
