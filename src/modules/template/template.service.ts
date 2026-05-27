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
        // Footer variant is always determined by the protocol's tier — never by
        // a user-supplied value. This keeps the Herald footer tamper-proof.
        footerKey = this.tierToFooterKey(tier);
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
        footerKey = this.tierToFooterKey(tier);
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
   * Render a full preview of a stored custom template exactly as it will be
   * sent — including the Herald footer injected for the protocol's tier.
   * Variables that aren't supplied fall back to placeholder values so the
   * preview always looks populated rather than blank.
   */
  async renderPreview(
    templateId: string,
    protocolId: string,
    protocolName: string,
    tier: number,
    variables: Record<string, unknown> = {},
  ): Promise<{ html: string; text: string }> {
    const previewVars: Record<string, unknown> = {
      protocolName,
      subject: variables.subject ?? `${protocolName} Notification`,
      body: variables.body ?? '_Preview body — replace with real content._',
      category: variables.category ?? 'defi',
      walletAddress: variables.walletAddress ?? '0x0000…0000',
      unsubscribeUrl: 'https://notify.useherald.xyz/unsubscribe/preview',
      logoUrl: variables.logoUrl ?? null,
      websiteUrl: variables.websiteUrl ?? null,
      bannerUrl: variables.bannerUrl ?? null,
      ...variables,
    };

    const category =
      typeof previewVars.category === 'string' ? previewVars.category : 'defi';
    const templateName = category === 'defi' ? 'defi-alert' : category;

    const { html, text } = await this.render({
      template: templateName,
      templateId,
      protocolId,
      tier,
      variables: previewVars,
    });

    return { html, text };
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

    // Pre-process: convert <Unsubscribe> shorthand to a proper anchor BEFORE
    // DOMPurify sanitisation — otherwise DOMPurify strips the unknown tag and
    // the literal text "<Unsubscribe>" ends up visible in the sent email.
    source = source.replace(
      /<Unsubscribe\s*\/?>/gi,
      '<a href="{{unsubscribeUrl}}" style="color:#64748B;text-decoration:none;">Unsubscribe</a>',
    );

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
   * Unique Herald footer CSS — all classes use the `hrl-` prefix so protocol
   * templates cannot accidentally or deliberately override them.
   * Every structural rule also has a matching inline style= on the element
   * (inline styles beat class rules without !important), giving two layers of
   * protection. The @import brings in the same fonts used by system templates
   * so the rendered footer is pixel-identical.
   */
  private readonly HERALD_FOOTER_STYLES = `
<style>
  /* Herald Protocol footer — do not modify. Classes are scoped with hrl- prefix. */
  @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700&family=Plus+Jakarta+Sans:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap');
  .hrl-footer        { padding:28px 8px 8px !important; font-family:'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif !important; }
  .hrl-meta          { font-size:12.5px !important; line-height:1.65 !important; color:#64748B !important; margin:0 !important; }
  .hrl-delivered-lbl { display:block !important; font-size:11px !important; text-transform:uppercase !important; letter-spacing:0.12em !important; font-weight:600 !important; color:#64748B !important; margin-bottom:6px !important; }
  .hrl-wallet        { font-family:'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace !important; font-size:12px !important; color:#475569 !important; word-break:break-all !important; }
  .hrl-divider       { height:1px !important; background:#E2E8F0 !important; margin:20px 0 18px !important; border:0 !important; }
  .hrl-brand-tbl     { font-size:12px !important; color:#64748B !important; border-collapse:collapse !important; }
  .hrl-brand-tbl td  { vertical-align:middle !important; }
  .hrl-logo-td       { padding-right:6px !important; line-height:0 !important; }
  .hrl-logo-td img   { display:block !important; border-radius:5px !important; }
  .hrl-name-td       { font-family:'Syne',sans-serif !important; font-weight:700 !important; font-size:12px !important; color:#475569 !important; letter-spacing:-0.01em !important; padding-right:2px !important; }
  .hrl-pipe-td       { color:#CBD5E1 !important; padding:0 4px !important; }
  .hrl-link-td a     { color:#64748B !important; text-decoration:none !important; }
</style>`.trim();

  // Sentinel: present in every injected Herald footer — used to skip re-injection.
  private static readonly HRL_SENTINEL = 'data-hrl-footer="1"';

  private injectHeraldFooter(
    html: string,
    variables: Record<string, unknown>,
    footerKey: string | null,
  ): string {
    // System templates already have a built-in footer — skip.
    if (footerKey === null || html.includes('class="footer-brand"')) {
      return html;
    }
    // Already injected (e.g. called twice) — skip.
    if (html.includes(TemplateService.HRL_SENTINEL)) {
      return html;
    }

    const unsub         = (variables.unsubscribeUrl as string) || '#';
    const protocolName  = (variables.protocolName  as string) || '';
    const walletAddress = (variables.walletAddress as string) || '';
    const websiteUrl    = (variables.websiteUrl    as string) || '';
    const logo          = HERALD_LOGO_URL;
    const fontStack     = `'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;
    const monoStack     = `'JetBrains Mono',ui-monospace,'SF Mono',Menlo,monospace`;

    // ── "Delivered to" + wallet ───────────────────────────────────────────────
    const deliveredTo = walletAddress
      ? `<p class="hrl-meta" style="font-size:12.5px;line-height:1.65;color:#64748B;margin:0;">` +
          `<span class="hrl-delivered-lbl" style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:0.12em;font-weight:600;color:#64748B;margin-bottom:6px;">Delivered to</span>` +
          `<span class="hrl-wallet" style="font-family:${monoStack};font-size:12px;color:#475569;word-break:break-all;">${walletAddress}</span>` +
        `</p>`
      : '';

    // ── Privacy note ──────────────────────────────────────────────────────────
    const protocolRef = websiteUrl
      ? `<a href="${websiteUrl}" style="color:#475569;font-weight:600;text-decoration:none;">${protocolName}</a>`
      : `<strong style="color:#475569;font-weight:600;">${protocolName || 'The sending protocol'}</strong>`;
    const privacyNote =
      `<p class="hrl-meta" style="font-size:12.5px;line-height:1.65;color:#64748B;margin:${walletAddress ? '14px' : '0'} 0 0;">` +
        `Delivered securely by Herald Protocol. ${protocolRef} does not have access to your email address.` +
      `</p>`;

    // ── Divider ───────────────────────────────────────────────────────────────
    const divider = `<hr class="hrl-divider" style="height:1px;background:#E2E8F0;margin:20px 0 18px;border:0;">`;

    // ── Brand table cells (exact structure from defi-alert/index.hbs) ─────────
    const logoTd =
      `<td class="hrl-logo-td" style="vertical-align:middle;padding-right:6px;line-height:0;" valign="middle">` +
        `<img src="${logo}" width="20" height="20" alt="" style="display:block;border-radius:5px;">` +
      `</td>`;
    const nameTd =
      `<td class="hrl-name-td" style="vertical-align:middle;font-family:'Syne',sans-serif;font-weight:700;font-size:12px;color:#475569;letter-spacing:-0.01em;padding-right:2px;" valign="middle">Herald</td>`;
    const pipeTd =
      `<td class="hrl-pipe-td" style="vertical-align:middle;color:#CBD5E1;padding:0 4px;" valign="middle">|</td>`;
    const unsubTd =
      `<td class="hrl-link-td" style="vertical-align:middle;" valign="middle">` +
        `<a href="${unsub}" style="color:#64748B;text-decoration:none;">Unsubscribe</a>` +
      `</td>`;
    const siteTd =
      `<td class="hrl-link-td" style="vertical-align:middle;" valign="middle">` +
        `<a href="https://useherald.xyz" style="color:#64748B;text-decoration:none;">useherald.xyz</a>` +
      `</td>`;

    const mkTable = (cells: string) =>
      `<table class="hrl-brand-tbl" cellpadding="0" cellspacing="0" style="font-size:12px;color:#64748B;">` +
        `<tr>${cells}</tr>` +
      `</table>`;

    const fullBrandRow  = mkTable(logoTd + nameTd + pipeTd + unsubTd + pipeTd + siteTd);
    const shortBrandRow = mkTable(logoTd + nameTd + pipeTd + unsubTd);

    // ── Outer wrapper (sentinel attribute makes re-injection detection reliable) ─
    const wrap = (inner: string, extraStyle = '') =>
      `<div class="hrl-footer" ${TemplateService.HRL_SENTINEL} style="padding:28px 8px 8px;font-family:${fontStack};${extraStyle}">` +
        inner +
      `</div>`;

    // ── Tier variants — structure matches system template footer exactly ───────
    const footers: Record<string, string> = {
      // Developer (0): wallet + privacy note + divider + full brand row
      full:       wrap(deliveredTo + privacyNote + divider + fullBrandRow),
      // Growth (1): wallet + divider + full brand row (no privacy note)
      small:      wrap(deliveredTo + divider + fullBrandRow),
      // Scale (2): wallet + divider + short brand row (no useherald.xyz)
      minimal:    wrap(deliveredTo + divider + shortBrandRow),
      // Enterprise (3): same as minimal
      enterprise: wrap(deliveredTo + divider + shortBrandRow),
      // No branding: centred unsubscribe only
      none:       wrap(`<a href="${unsub}" style="font-size:12px;color:#64748B;text-decoration:none;">Unsubscribe</a>`, 'text-align:center;padding:12px 8px 8px;'),
    };

    const footerHtml = footers[footerKey] ?? footers['full'];

    // Wrap the footer in a full-width outer shell that centres content at
    // max-width 600px — identical to the email body container — so the footer
    // never bleeds to the edge of the viewport in wide-windowed email clients.
    const containedFooter =
      `<div style="width:100%;background:#F8FAFC;">` +
        `<div style="max-width:600px;margin:0 auto;padding:0 16px 32px;box-sizing:border-box;">` +
          footerHtml +
        `</div>` +
      `</div>`;

    // Inject font + CSS into <head> once, then append footer before </body>.
    let result = html;
    if (!result.includes('data-hrl-footer')) {
      result = result.includes('</head>')
        ? result.replace('</head>', `${this.HERALD_FOOTER_STYLES}\n</head>`)
        : this.HERALD_FOOTER_STYLES + result;
    }
    result = result.includes('</body>')
      ? result.replace('</body>', `${containedFooter}\n</body>`)
      : result + containedFooter;

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
