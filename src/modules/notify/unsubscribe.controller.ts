import {
  Controller,
  Get,
  Post,
  Param,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import type { Response } from 'express';
import { UnsubscribeService } from './unsubscribe.service';

/**
 * UnsubscribeController — handles email unsubscribe link clicks.
 *
 * Two endpoints:
 *   GET  /unsubscribe/:token — Shows confirmation page (human-friendly)
 *   POST /unsubscribe/:token — Executes unsubscribe (List-Unsubscribe-Post / RFC 8058)
 *
 * No authentication required — the HMAC token IS the auth.
 */
@ApiTags('Unsubscribe')
@Controller('unsubscribe')
export class UnsubscribeController {
  constructor(private readonly unsubscribeService: UnsubscribeService) {}

  /**
   * GET /unsubscribe/:token — Render an HTML confirmation page.
   * User clicks the link in their email and sees this page.
   */
  @Get(':token')
  @ApiOperation({ summary: 'Show unsubscribe confirmation page' })
  @ApiParam({ name: 'token', description: 'Signed unsubscribe token' })
  @ApiResponse({ status: 200, description: 'Confirmation page rendered' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  showConfirmation(@Param('token') token: string, @Res() res: Response) {
    const payload = this.unsubscribeService.decodeToken(token);

    if (!payload) {
      return res.status(400).send(this.renderErrorPage());
    }

    const escapeHtml = (unsafe: string) => {
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    const categoryLabel =
      !payload.category || payload.category === 'all'
        ? 'all notifications'
        : `${escapeHtml(payload.category)} notifications`;

    return res
      .status(200)
      .send(this.renderConfirmationPage(token, categoryLabel));
  }

  /**
   * POST /unsubscribe/:token — Execute the unsubscribe action.
   *
   * Handles both:
   *   - Manual form submission from the confirmation page
   *   - One-click List-Unsubscribe-Post (RFC 8058) from email clients
   */
  @Post(':token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute unsubscribe' })
  @ApiParam({ name: 'token', description: 'Signed unsubscribe token' })
  @ApiResponse({ status: 200, description: 'Successfully unsubscribed' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async executeUnsubscribe(
    @Param('token') token: string,
    @Res() res: Response,
  ) {
    const result = await this.unsubscribeService.validateAndExecute(token);

    if (!result.success) {
      return res.status(400).send(this.renderErrorPage(result.error));
    }

    const escapeHtml = (unsafe: string) => {
      return unsafe
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    };

    const categoryLabel =
      !result.payload?.category || result.payload.category === 'all'
        ? 'all notifications'
        : `${escapeHtml(result.payload.category)} notifications`;

    return res.status(200).send(this.renderSuccessPage(categoryLabel));
  }

  // ── HTML Page Renderers ──────────────────────────────────────────────

  private renderConfirmationPage(token: string, categoryLabel: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribe — Herald</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #040C18; color: #F0F6FF; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #0A1628; border: 1px solid #1A2D3D; border-radius: 12px; padding: 40px; max-width: 460px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #00C896; }
    p { color: #8BA3B9; margin: 16px 0; line-height: 1.6; }
    .category { color: #F0F6FF; font-weight: 600; }
    form { margin-top: 24px; }
    button { background: #DC2626; color: white; border: none; padding: 12px 32px; border-radius: 8px; font-size: 16px; cursor: pointer; transition: background 0.2s; }
    button:hover { background: #B91C1C; }
    .note { font-size: 12px; color: #4A6375; margin-top: 16px; }
    .logo { font-size: 14px; color: #2D4A5E; margin-top: 24px; }
    .logo span { color: #00C896; }
  </style>
</head>
<body>
  <div class="card">
    <h1>◈ Unsubscribe</h1>
    <p>You're about to unsubscribe from <span class="category">${categoryLabel}</span>.</p>
    <p>You can re-enable notifications anytime at <a href="https://app.useherald.xyz" style="color:#00C896;">app.useherald.xyz</a></p>
    <form method="POST" action="/unsubscribe/${token}">
      <button type="submit">Confirm Unsubscribe</button>
    </form>
    <p class="note">This link expires in 7 days.</p>
    <p class="logo"><span>◈</span> Herald — Privacy-preserving notifications for Solana</p>
  </div>
</body>
</html>`;
  }

  private renderSuccessPage(categoryLabel: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Unsubscribed — Herald</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #040C18; color: #F0F6FF; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #0A1628; border: 1px solid #1A2D3D; border-radius: 12px; padding: 40px; max-width: 460px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #00C896; }
    p { color: #8BA3B9; margin: 16px 0; line-height: 1.6; }
    .check { font-size: 48px; margin-bottom: 16px; }
    .logo { font-size: 14px; color: #2D4A5E; margin-top: 24px; }
    .logo span { color: #00C896; }
  </style>
</head>
<body>
  <div class="card">
    <div class="check">✓</div>
    <h1>Unsubscribed</h1>
    <p>You've been unsubscribed from <strong>${categoryLabel}</strong>.</p>
    <p>Changed your mind? Visit <a href="https://app.useherald.xyz" style="color:#00C896;">app.useherald.xyz</a> to manage preferences.</p>
    <p class="logo"><span>◈</span> Herald</p>
  </div>
</body>
</html>`;
  }

  private renderErrorPage(error?: string): string {
    const message = error || 'This unsubscribe link is invalid or has expired.';
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error — Herald</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #040C18; color: #F0F6FF; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #0A1628; border: 1px solid #1A2D3D; border-radius: 12px; padding: 40px; max-width: 460px; text-align: center; }
    h1 { font-size: 24px; margin-bottom: 8px; color: #EF4444; }
    p { color: #8BA3B9; margin: 16px 0; line-height: 1.6; }
    .logo { font-size: 14px; color: #2D4A5E; margin-top: 24px; }
    .logo span { color: #00C896; }
  </style>
</head>
<body>
  <div class="card">
    <h1>⚠ Error</h1>
    <p>${message}</p>
    <p>Visit <a href="https://app.useherald.xyz" style="color:#00C896;">app.useherald.xyz</a> to manage your notification preferences directly.</p>
    <p class="logo"><span>◈</span> Herald</p>
  </div>
</body>
</html>`;
  }
}
