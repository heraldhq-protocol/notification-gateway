import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import juice from 'juice';
import { marked } from 'marked';
import { PrismaService } from '../../database/prisma.service';
import { getTierLimits } from '../auth/rate-limit.constants';
import {
  parseMarkdownLinks,
  convertLinksToHtml,
} from '../../common/utils/link-parser';
import { MjmlCompilerService } from './mjml-compiler.service';
import { XssSanitizer } from './utils/xss-sanitizer';

const HERALD_LOGO_URL =
  'https://herald-storage-bucket.s3.eu-north-1.amazonaws.com/herald-logo.svg';

export interface RenderParams {
  template: string;
  variables: Record<string, unknown>;
  protocolId?: string;
  templateId?: string;
  tier?: number;
}

export interface RenderedEmail {
  html: string;
  text: string;
  subject: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  compiledHtml?: string;
  error?: string;
  errors?: string[];
}

/**
 * TemplateService — renders notification emails with tiered branding.
 *
 * Template selection waterfall:
 *   1. Specific templateId in notify request → use it (Growth+ tier)
 *   2. Protocol has a default template for category → use it (Growth+ tier)
 *   3. Herald system default for category → always available
 *
 * Herald footer visibility by tier:
 *   Developer  (0): Full Herald branding — prominent logo + description
 *   Growth     (1): Small "via Herald" line
 *   Scale      (2): Minimal — unsubscribe link only + tiny Herald mention
 *   Enterprise (3): Unsubscribe link only — Herald removed
 */
@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);
  private readonly templateDir: string;
  private readonly templateCache = new Map<
    string,
    HandlebarsTemplateDelegate
  >();
  private readonly xssSanitizer: XssSanitizer;
  private readonly mjmlCompiler: MjmlCompilerService;

  constructor(private readonly prisma: PrismaService) {
    const isProd = process.env.NODE_ENV === 'production';
    this.templateDir = isProd
      ? path.join(process.cwd(), 'dist', 'modules', 'template', 'templates')
      : path.join(process.cwd(), 'src', 'modules', 'template', 'templates');

    this.xssSanitizer = new XssSanitizer();
    this.mjmlCompiler = new MjmlCompilerService();
    this.logger.log(`Template directory: ${this.templateDir}`);
    this.registerHelpers();
  }

  /**
   * Render a complete email with HTML + plain text parts.
   * Applies tiered Herald footer before returning.
   */
  async render(params: RenderParams): Promise<RenderedEmail> {
    const { template, variables, protocolId, templateId, tier = 0 } = params;

    // Template waterfall: custom templateId → custom default → system default
    let hbsSource: string | null = null;

    if (templateId && protocolId) {
      hbsSource = await this.loadCustomTemplate(templateId, protocolId);
    }

    if (!hbsSource && protocolId) {
      hbsSource = await this.loadProtocolDefaultTemplate(
        protocolId,
        template, // template name = category
      );
    }

    if (!hbsSource) {
      hbsSource = await this.loadSystemTemplate(template);
    }

    // Handlebars: variable injection
    const compiled = this.getCompiledTemplate(hbsSource);

    // Auto-convert markdown links in body variables
    const processedVars = this.processBodyLinks(variables);
    const htmlWithVars = compiled(processedVars);

    // Juice: inline CSS for email client compatibility
    const inlinedHtml = juice(htmlWithVars, { removeStyleTags: false });

    // Inject tiered Herald footer
    const htmlWithFooter = this.injectHeraldFooter(
      inlinedHtml,
      variables,
      tier,
    );

    // Plain text fallback
    const plainText = this.renderPlainTextFallback(variables);

    return {
      html: htmlWithFooter,
      text: plainText,
      subject: (variables.subject as string) || 'Notification from Herald',
    };
  }

  /**
   * Validate a custom HTML template (Growth+ tier).
   * Returns validated/sanitized HTML or validation errors.
   */
  validateCustomTemplate(
    source: string,
    tier: number,
  ): TemplateValidationResult {
    const limits = getTierLimits(tier);
    if (limits.customTemplates === 0) {
      return {
        valid: false,
        error: 'Custom templates require the Growth plan or higher.',
      };
    }

    // Basic validation: ensure Handlebars can compile it
    try {
      Handlebars.compile(source);
    } catch (err: any) {
      return { valid: false, error: `Template syntax error: ${err.message}` };
    }

    // Strip dangerous tags/attrs (no XSS via custom templates)
    const sanitized = this.sanitizeHtml(source);
    return { valid: true, compiledHtml: sanitized };
  }

  // ── Footer injection ─────────────────────────────────────────────────────

  private injectHeraldFooter(
    html: string,
    variables: Record<string, unknown>,
    tier: number,
  ): string {
    const unsubscribeUrl = (variables.unsubscribeUrl as string) || '#';

    const footers: Record<string, string> = {
      full: `
        <div style="background:#040C18;padding:24px 32px;border-top:1px solid #0E2A3D;font-family:Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <span style="font-size:18px;font-weight:800;color:#00C896;">◈ Herald</span><br>
              <span style="font-size:11px;color:#2D4A5E;">
                Privacy-preserving DeFi notifications. <a href="https://useherald.xyz" style="color:#007A5C;">useherald.xyz</a>
              </span>
            </td>
            <td align="right" valign="top">
              <a href="${unsubscribeUrl}" style="font-size:11px;color:#2D4A5E;">Unsubscribe</a>
            </td>
          </tr></table>
        </div>`,

      small: `
        <div style="background:#040C18;padding:16px 32px;border-top:1px solid #071520;font-family:Arial,sans-serif;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <span style="font-size:11px;color:#2D4A5E;">
                Delivered securely via <a href="https://useherald.xyz" style="color:#007A5C;">Herald</a>
              </span>
            </td>
            <td align="right">
              <a href="${unsubscribeUrl}" style="font-size:11px;color:#2D4A5E;">Unsubscribe</a>
            </td>
          </tr></table>
        </div>`,

      minimal: `
        <div style="background:#040C18;padding:12px 32px;border-top:1px solid #071520;text-align:center;font-family:Arial,sans-serif;">
          <a href="${unsubscribeUrl}" style="font-size:11px;color:#2D4A5E;">Unsubscribe</a>
          &nbsp;·&nbsp;
          <span style="font-size:11px;color:#1A2D3D;">◈ Herald</span>
        </div>`,

      none: `
        <div style="padding:12px 32px;text-align:center;font-family:Arial,sans-serif;">
          <a href="${unsubscribeUrl}" style="font-size:11px;color:#666;">Unsubscribe</a>
        </div>`,

      enterprise: `
        <div style="padding:16px 32px;text-align:center;font-family:Arial,sans-serif;border-top:1px solid #e5e7eb;">
          <img src="${HERALD_LOGO_URL}" alt="Herald" width="20" height="20" style="vertical-align:middle;margin-right:6px;">
          <span style="font-size:11px;color:#666;">Herald</span>
          <span style="color:#ccc;margin:0 8px;">|</span>
          <a href="${unsubscribeUrl}" style="font-size:11px;color:#666;">Unsubscribe</a>
        </div>`,
    };

    const footerKey =
      tier === 0
        ? 'full'
        : tier === 1
          ? 'small'
          : tier === 2
            ? 'minimal'
            : tier === 3
              ? 'enterprise'
              : 'none';

    // System templates already include their own footer (Herald logo + unsubscribe).
    // Only inject when the template doesn't have one to avoid a duplicate footer.
    if (html.includes('footer-brand')) {
      return html;
    }

    const footer = footers[footerKey];
    return html.includes('</body>')
      ? html.replace('</body>', `${footer}</body>`)
      : html + footer;
  }

  // ── Template loading ─────────────────────────────────────────────────────

  private async loadCustomTemplate(
    templateId: string,
    protocolId: string,
  ): Promise<string | null> {
    try {
      const tmpl = await this.prisma.notificationTemplate.findFirst({
        where: { id: templateId, protocolId, isActive: true },
      });
      return tmpl?.htmlSource ?? null;
    } catch {
      return null;
    }
  }

  private async loadProtocolDefaultTemplate(
    protocolId: string,
    category: string,
  ): Promise<string | null> {
    try {
      const tmpl = await this.prisma.notificationTemplate.findFirst({
        where: { protocolId, category, isDefault: true, isActive: true },
      });
      return tmpl?.htmlSource ?? null;
    } catch {
      return null;
    }
  }

  private async loadSystemTemplate(name: string): Promise<string> {
    const templatePath = path.join(this.templateDir, name, 'index.hbs');
    try {
      return await fs.promises.readFile(templatePath, 'utf-8');
    } catch {
      // Fallback to defi-alert
      this.logger.warn(
        `Template "${name}" not found, using defi-alert fallback`,
      );
      const fallbackPath = path.join(
        this.templateDir,
        'defi-alert',
        'index.hbs',
      );
      try {
        return await fs.promises.readFile(fallbackPath, 'utf-8');
      } catch {
        // Last resort: return a minimal inline template
        return this.getMinimalFallbackTemplate();
      }
    }
  }

  /** Cache compiled Handlebars templates in memory to avoid repeated compilation. */
  private getCompiledTemplate(source: string): HandlebarsTemplateDelegate {
    const key = this.sha(source);
    if (!this.templateCache.has(key)) {
      this.templateCache.set(key, Handlebars.compile(source));
    }
    return this.templateCache.get(key)!;
  }

  // ── Plain text ────────────────────────────────────────────────────────────

  private renderPlainTextFallback(vars: Record<string, unknown>): string {
    const protocol = (vars.protocolName as string) || 'Herald';
    const subject = (vars.subject as string) || 'Notification';
    const body = (vars.body as string) || '';

    return [
      `${protocol} — ${subject}`,
      '',
      '─'.repeat(40),
      '',
      body,
      '',
      '─'.repeat(40),
      '',
      `Unsubscribe: ${vars.unsubscribeUrl}`,
      'Delivered by Herald | https://useherald.xyz',
    ].join('\n');
  }

  // ── Security ──────────────────────────────────────────────────────────────

  private sha(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  private getMinimalFallbackTemplate(): string {
    return `
      <html><body style="font-family:Arial,sans-serif;background:#040C18;color:#F0F6FF;padding:32px;">
        <h2 style="color:#00C896;">{{protocolName}}</h2>
        <h3>{{subject}}</h3>
        <p>{{body}}</p>
      </body></html>`;
  }

  private sanitizeHtml(html: string): string {
    let sanitized = html.replace(/\s*on\w+\s*=\s*(['"])[^'"]*\1/gi, '');
    sanitized = this.xssSanitizer.sanitize(sanitized, {
      maxLength: 51200,
    }).html;
    return sanitized;
  }

  // ── Handlebars helpers ─────────────────────────────────────────────────────

  private processBodyLinks(
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const processed = { ...variables };

    if (processed.body && typeof processed.body === 'string') {
      const { links } = parseMarkdownLinks(processed.body);
      processed.body = convertLinksToHtml(processed.body, links);
    }

    return processed;
  }

  private registerHelpers(): void {
    Handlebars.registerHelper('truncate', (str: string, len: number) =>
      str?.length > len ? str.slice(0, len) + '...' : str,
    );
    Handlebars.registerHelper('formatDate', (ts: number) =>
      new Date(ts * 1000).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }),
    );
    Handlebars.registerHelper(
      'categoryColor',
      (category: string) =>
        ({
          defi: '#EF4444',
          governance: '#8B5CF6',
          system: '#F59E0B',
          marketing: '#10B981',
          security: '#EF4444',
        })[category] ?? '#00C896',
    );
    Handlebars.registerHelper(
      'categoryLabel',
      (category: string) =>
        ({
          defi: 'DeFi Alert',
          governance: 'Governance',
          system: 'System',
          marketing: 'Update',
          security: 'Security',
        })[category] ?? 'Notification',
    );
    Handlebars.registerHelper(
      'categoryEmoji',
      (category: string) =>
        ({
          defi: '🔴',
          governance: '🏛',
          system: '⚙️',
          marketing: '📢',
          security: '🔒',
        })[category] ?? '🔔',
    );
    Handlebars.registerHelper('markdown', (content: string) => {
      if (!content) return '';
      return new Handlebars.SafeString(
        marked.parse(content, { gfm: true }) as string,
      );
    });
    Handlebars.registerHelper('money', (amount: number, symbol = 'USDC') => {
      if (typeof amount !== 'number') {
        return `${amount} ${symbol}`;
      }
      return `${amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${symbol}`;
    });
    Handlebars.registerHelper(
      'truncateAddress',
      (address: string, chars = 4) => {
        if (!address || typeof address !== 'string') {
          return '';
        }
        if (address.length <= chars * 2 + 3) {
          return address;
        }
        return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
      },
    );
    Handlebars.registerHelper('timeAgo', (timestamp: number) => {
      if (!timestamp) return '';
      const now = Math.floor(Date.now() / 1000);
      const seconds = now - timestamp;
      if (seconds < 60) return 'just now';
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
      if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
      if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
      return new Date(timestamp * 1000).toLocaleDateString();
    });
    Handlebars.registerHelper('convertLinks', (body: string) => {
      if (!body) return '';
      const { links } = parseMarkdownLinks(body);
      const converted = convertLinksToHtml(body, links);
      return new Handlebars.SafeString(converted);
    });
    Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    Handlebars.registerHelper('truncate', (str: string, len: number) =>
      str?.length > len ? str.slice(0, len) + '...' : str,
    );
  }
}
