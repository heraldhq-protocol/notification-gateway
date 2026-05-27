import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import juice from 'juice';
import { marked } from 'marked';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { PrismaService } from '../../database/prisma.service';
import { getTierLimits } from '../auth/rate-limit.constants';
import {
  parseMarkdownLinks,
  convertLinksToHtml,
} from '../../common/utils/link-parser';
// Tags/attrs DOMPurify must preserve when sanitising user-submitted template HTML.
// Must allow <style>, <head>, <meta>, <link> so Google Fonts and inline CSS survive.
const TEMPLATE_ALLOWED_TAGS = [
  'html',
  'head',
  'body',
  'title',
  'style',
  'meta',
  'link',
  'div',
  'span',
  'section',
  'article',
  'header',
  'footer',
  'main',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'center',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'colgroup',
  'col',
  'caption',
  'p',
  'br',
  'hr',
  'pre',
  'code',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'big',
  'sub',
  'sup',
  'abbr',
  'cite',
  'q',
  'dfn',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'a',
  'img',
  'font',
];

const TEMPLATE_ALLOWED_ATTRS = [
  'style',
  'class',
  'id',
  'dir',
  'lang',
  'title',
  'width',
  'height',
  'align',
  'valign',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'scope',
  'summary',
  'span',
  'color',
  'face',
  'size',
  'href',
  'src',
  'alt',
  'target',
  'rel',
  'charset',
  'http-equiv',
  'content',
  'name',
  'media',
  'role',
  'aria-label',
  'aria-hidden',
  'aria-describedby',
];

const HERALD_LOGO_URL =
  'https://herald-storage-bucket.s3.eu-north-1.amazonaws.com/herald-logo.svg';

export interface RenderParams {
  template: string;
  variables: Record<string, unknown>;
  protocolId?: string;
  templateId?: string;
  tier?: number;
}

interface CustomTemplateRecord {
  htmlSource: string;
  heraldFooter: string | null;
  textSource: string | null;
  previewText: string | null;
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
  private readonly purify: any;

  constructor(private readonly prisma: PrismaService) {
    const isProd = process.env.NODE_ENV === 'production';
    this.templateDir = isProd
      ? path.join(process.cwd(), 'dist', 'modules', 'template', 'templates')
      : path.join(process.cwd(), 'src', 'modules', 'template', 'templates');

    const jsdomWindow = new JSDOM('').window;
    this.purify = createDOMPurify(jsdomWindow);
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
    // footerKey is null for system templates (they have their own footer already).
    // For custom templates it's the key ('full'|'small'|'minimal'|'enterprise'|'none').
    let footerKey: string | null = null;
    let storedTextSource: string | null = null;
    let storedPreviewText: string | null = null;

    if (templateId && protocolId) {
      const custom = await this.loadCustomTemplate(templateId, protocolId);
      if (custom) {
        hbsSource = custom.htmlSource;
        footerKey = custom.heraldFooter ?? this.tierToFooterKey(tier);
        storedTextSource = custom.textSource;
        storedPreviewText = custom.previewText;
      }
    }

    if (!hbsSource && protocolId) {
      const custom = await this.loadProtocolDefaultTemplate(
        protocolId,
        template,
      );
      if (custom) {
        hbsSource = custom.htmlSource;
        footerKey = custom.heraldFooter ?? this.tierToFooterKey(tier);
        storedTextSource = custom.textSource;
        storedPreviewText = custom.previewText;
      }
    }

    if (!hbsSource) {
      hbsSource = await this.loadSystemTemplate(template);
      // System templates carry their own footer — don't inject a second one.
      footerKey = null;
    }

    // Pre-process: replace <Unsubscribe> placeholder tags with a proper HBS variable
    // so protocols can use <Unsubscribe> in their custom templates as a shorthand.
    hbsSource = hbsSource.replace(
      /<Unsubscribe\s*\/?>/gi,
      '<a href="{{unsubscribeUrl}}" style="color:#64748B;text-decoration:none;">Unsubscribe</a>',
    );

    // Handlebars: variable injection
    const compiled = this.getCompiledTemplate(hbsSource);

    // Auto-convert markdown links in body variables
    const processedVars = this.processBodyLinks(variables);
    const htmlWithVars = compiled(processedVars);

    // Juice: inline CSS for email client compatibility.
    // Options:
    //   removeStyleTags:false    — keep <style> for clients that support it (Gmail web, Apple Mail)
    //   preserveMediaQueries     — keep @media (dark mode + responsive) inside <style>
    //   preserveFontFaces        — keep @font-face / @import for webfont clients
    //   preserveImportant        — honour !important declarations after inlining
    //   applyStyleTags  — also inline existing style="" attributes
    const inlinedHtml = juice(htmlWithVars, {
      removeStyleTags: false,
      preserveMediaQueries: true,
      preserveFontFaces: true,
      preserveImportant: true,
      applyStyleTags: true,
    });

    // Inject previewText as email preheader (invisible preview text in inbox)
    const previewTextValue =
      storedPreviewText || (variables.previewText as string) || '';
    const htmlWithPreheader = this.injectPreheader(
      inlinedHtml,
      previewTextValue,
    );

    // Inject Herald footer for custom templates only (always-on, mandatory).
    // System templates carry their own footer so footerKey is null for those.
    const htmlWithFooter = this.injectHeraldFooter(
      htmlWithPreheader,
      variables,
      footerKey,
    );

    // Use stored plain-text override if provided, otherwise generate fallback
    const plainText = storedTextSource
      ? Handlebars.compile(storedTextSource)(processedVars)
      : this.renderPlainTextFallback(variables);

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

  // ── Preheader injection ───────────────────────────────────────────────────

  private injectPreheader(html: string, previewText: string): string {
    if (!previewText || html.includes('class="preheader"')) return html;
    const escaped = previewText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const span =
      `<span class="preheader" style="display:none;visibility:hidden;opacity:0;` +
      `height:0;max-height:0;overflow:hidden;font-size:1px;line-height:1px;` +
      `color:transparent;mso-hide:all;">${escaped}</span>`;
    return html.includes('<body')
      ? html.replace(/<body[^>]*>/, (tag) => tag + span)
      : span + html;
  }

  // ── Footer injection ─────────────────────────────────────────────────────

  private tierToFooterKey(tier: number): string {
    if (tier === 0) return 'full';
    if (tier === 1) return 'small';
    if (tier === 2) return 'minimal';
    if (tier === 3) return 'enterprise';
    return 'none';
  }

  /**
   * Inject a Herald-branded footer into custom user templates.
   * Pass `footerKey = null` for system templates — they already embed their own footer.
   *
   * HTML structure mirrors the defi-alert system template footer exactly:
   * divider → optional privacy note → logo/Herald/pipe/Unsubscribe[/pipe/site] table.
   */
  /**
   * Herald brand CSS injected into every custom template <head>.
   *
   * Imports the same fonts used by Herald's system templates (Syne + Plus Jakarta Sans)
   * and defines scoped .herald-footer-* classes so the footer always renders
   * consistently regardless of what CSS the protocol's own template uses.
   * Inline styles on each element remain as fallback for clients that strip <style>.
   */
  private readonly HERALD_FOOTER_STYLES = `
<style>
  /* Herald footer — managed by Herald Protocol, do not remove */
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700&family=Plus+Jakarta+Sans:wght@400;600&display=swap');
  .herald-footer { padding:28px 8px 8px !important; font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif !important; }
  .herald-footer-divider { height:1px !important; background:#E2E8F0 !important; margin:20px 0 18px !important; border:0 !important; }
  .herald-footer-privacy { font-size:12.5px !important; line-height:1.65 !important; color:#64748B !important; margin:0 !important; }
  .herald-footer-privacy strong { color:#475569 !important; font-weight:600 !important; }
  .herald-footer-table { font-size:12px !important; color:#64748B !important; border-collapse:collapse !important; }
  .herald-footer-logo { vertical-align:middle !important; padding-right:6px !important; line-height:0 !important; }
  .herald-footer-logo img { display:block !important; border-radius:5px !important; }
  .herald-footer-name { vertical-align:middle !important; font-family:'Syne',sans-serif !important; font-weight:700 !important; font-size:12px !important; color:#475569 !important; letter-spacing:-0.01em !important; padding-right:2px !important; }
  .herald-footer-pipe { vertical-align:middle !important; color:#CBD5E1 !important; padding:0 4px !important; }
  .herald-footer-link { vertical-align:middle !important; }
  .herald-footer-link a { color:#64748B !important; text-decoration:none !important; }
</style>`.trim();

  private injectHeraldFooter(
    html: string,
    variables: Record<string, unknown>,
    footerKey: string | null,
  ): string {
    // System templates carry a footer-brand element — skip to avoid duplication.
    if (footerKey === null || html.includes('footer-brand')) {
      return html;
    }

    const unsub = (variables.unsubscribeUrl as string) || '#';
    const protocolName = (variables.protocolName as string) || '';
    const logo = HERALD_LOGO_URL;

    // ── Footer HTML (classes + inline fallbacks for clients that strip <style>) ──

    const wrapOpen = `<div class="herald-footer footer-brand" style="padding:28px 8px 8px;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">`;
    const wrapClose = `</div>`;

    const divider = `<hr class="herald-footer-divider" style="height:1px;background:#E2E8F0;margin:20px 0 18px;border:0;">`;

    const privacy = protocolName
      ? `<p class="herald-footer-privacy" style="font-size:12.5px;line-height:1.65;color:#64748B;margin:0;">Delivered securely by Herald Protocol. <strong style="color:#475569;font-weight:600;">${protocolName}</strong> does not have access to your email address.</p>`
      : `<p class="herald-footer-privacy" style="font-size:12.5px;line-height:1.65;color:#64748B;margin:0;">Delivered securely by Herald Protocol. Your email address is never shared with the sending protocol.</p>`;

    const tbl = (cells: string) =>
      `<table class="herald-footer-table" cellpadding="0" cellspacing="0" style="font-size:12px;color:#64748B;">` +
      `<tr>${cells}</tr></table>`;

    const logoTd =
      `<td class="herald-footer-logo" style="vertical-align:middle;padding-right:6px;line-height:0;" valign="middle">` +
      `<img src="${logo}" width="20" height="20" alt="" style="display:block;border-radius:5px;"></td>`;
    const nameTd =
      `<td class="herald-footer-name" style="vertical-align:middle;font-family:'Syne',sans-serif;font-weight:700;font-size:12px;color:#475569;letter-spacing:-0.01em;padding-right:2px;" valign="middle">Herald</td>`;
    const pipeTd =
      `<td class="herald-footer-pipe" style="vertical-align:middle;color:#CBD5E1;padding:0 4px;" valign="middle">|</td>`;
    const unsubTd =
      `<td class="herald-footer-link" style="vertical-align:middle;" valign="middle">` +
      `<a href="${unsub}" style="color:#64748B;text-decoration:none;">Unsubscribe</a></td>`;
    const siteTd =
      `<td class="herald-footer-link" style="vertical-align:middle;" valign="middle">` +
      `<a href="https://useherald.xyz" style="color:#64748B;text-decoration:none;">useherald.xyz</a></td>`;

    const fullRow = tbl(logoTd + nameTd + pipeTd + unsubTd + pipeTd + siteTd);
    const shortRow = tbl(logoTd + nameTd + pipeTd + unsubTd);

    const footers: Record<string, string> = {
      // Developer (0) — privacy note + full brand row
      full: `${wrapOpen}${privacy}${divider}${fullRow}${wrapClose}`,
      // Growth (1) — full brand row, no privacy note
      small: `${wrapOpen}${divider}${fullRow}${wrapClose}`,
      // Scale (2) — short brand row (no site link)
      minimal: `${wrapOpen}${divider}${shortRow}${wrapClose}`,
      // Enterprise (3) — same as minimal
      enterprise: `${wrapOpen}${divider}${shortRow}${wrapClose}`,
      // No Herald branding — plain unsubscribe centred
      none:
        `<div class="herald-footer footer-brand" style="padding:12px 8px 8px;text-align:center;font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">` +
        `<a href="${unsub}" style="font-size:12px;color:#64748B;text-decoration:none;">Unsubscribe</a>` +
        `</div>`,
    };

    const footerHtml = footers[footerKey] ?? footers['full'];

    // Inject brand styles into <head> if not already present, then append footer before </body>.
    let result = html;
    if (!result.includes('herald-footer-name')) {
      result = result.includes('</head>')
        ? result.replace('</head>', `${this.HERALD_FOOTER_STYLES}\n</head>`)
        : this.HERALD_FOOTER_STYLES + result;
    }
    result = result.includes('</body>')
      ? result.replace('</body>', `${footerHtml}</body>`)
      : result + footerHtml;

    return result;
  }

  // ── Template loading ─────────────────────────────────────────────────────

  private async loadCustomTemplate(
    templateId: string,
    protocolId: string,
  ): Promise<CustomTemplateRecord | null> {
    try {
      const tmpl = await this.prisma.notificationTemplate.findFirst({
        where: { id: templateId, protocolId, isActive: true },
        select: {
          htmlSource: true,
          heraldFooter: true,
          textSource: true,
          previewText: true,
        },
      });
      if (!tmpl?.htmlSource) return null;
      return {
        htmlSource: tmpl.htmlSource,
        heraldFooter: tmpl.heraldFooter,
        textSource: tmpl.textSource,
        previewText: tmpl.previewText,
      };
    } catch {
      return null;
    }
  }

  private async loadProtocolDefaultTemplate(
    protocolId: string,
    category: string,
  ): Promise<CustomTemplateRecord | null> {
    try {
      const tmpl = await this.prisma.notificationTemplate.findFirst({
        where: { protocolId, category, isDefault: true, isActive: true },
        select: {
          htmlSource: true,
          heraldFooter: true,
          textSource: true,
          previewText: true,
        },
      });
      if (!tmpl?.htmlSource) return null;
      return {
        htmlSource: tmpl.htmlSource,
        heraldFooter: tmpl.heraldFooter,
        textSource: tmpl.textSource,
        previewText: tmpl.previewText,
      };
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
    // Strip event handlers first before DOMPurify pass
    let sanitized = html.replace(/\s*on\w+\s*=\s*(['"])[^'"]*\1/gi, '');
    sanitized = this.purify.sanitize(sanitized, {
      ALLOWED_TAGS: TEMPLATE_ALLOWED_TAGS,
      ALLOWED_ATTR: TEMPLATE_ALLOWED_ATTRS,
      ALLOW_DATA_ATTR: true,
      WHOLE_DOCUMENT: true,
      RETURN_DOM_FRAGMENT: false,
      RETURN_DOM: false,
      FORBID_TAGS: [
        'script',
        'noscript',
        'object',
        'embed',
        'applet',
        'form',
        'input',
        'button',
        'select',
        'textarea',
        'iframe',
      ],
      FORBID_ATTR: [
        'onerror',
        'onload',
        'onclick',
        'onmouseover',
        'onfocus',
        'onblur',
        'onchange',
        'onsubmit',
        'onkeydown',
        'onkeyup',
        'onkeypress',
      ],
    });
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
    Handlebars.registerHelper(
      'formatDate',
      (ts: number | string | undefined) => {
        if (ts === undefined || ts === null || ts === '') return '';
        // Accept Unix seconds (number), Unix ms (large number), or ISO strings
        let ms: number;
        if (typeof ts === 'string') {
          ms = Date.parse(ts);
        } else {
          // Heuristic: if the value is under 1e10 it's Unix seconds, otherwise ms
          ms = ts < 1e10 ? ts * 1000 : ts;
        }
        const d = new Date(ms);
        if (isNaN(d.getTime())) return String(ts); // show raw value rather than "Invalid Date"
        return d.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
      },
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
          yield: '#06B6D4',
          staking: '#3B82F6',
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
          yield: 'Yield',
          staking: 'Staking',
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
          yield: '💰',
          staking: '🔐',
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
