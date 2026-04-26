import { Injectable, Logger } from '@nestjs/common';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { UrlValidator } from './url-validator';

const ALLOWED_TAGS = [
  'html',
  'head',
  'body',
  'style',
  'meta',
  'title',
  'link',
  'img',
  'table',
  'tr',
  'td',
  'tbody',
  'thead',
  'tfoot',
  'th',
  'center',
  'font',
  'a',
  'p',
  'br',
  'hr',
  'div',
  'span',
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
  'strike',
  'ul',
  'ol',
  'li',
  'thead',
  'tbody',
  'pre',
  'code',
  'blockquote',
  'small',
  'sub',
  'sup',
  'table',
  'caption',
  'col',
  'colgroup',
  'iframe',
  'svg',
  'path',
  'circle',
  'rect',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'g',
  'defs',
  'clipPath',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'pattern',
  'filter',
  'mask',
  'foreignObject',
];

const ALLOWED_ATTRS = [
  'style',
  'class',
  'id',
  'width',
  'height',
  'align',
  'valign',
  'bgcolor',
  'border',
  'cellpadding',
  'cellspacing',
  'color',
  'dir',
  'lang',
  'target',
  'rel',
  'colspan',
  'rowspan',
  'headers',
  'scope',
  'frame',
  'rules',
  'summary',
  'cellspacing',
  'cellpadding',
  'border',
  'valign',
  'bgcolor',
  'background',
  'display',
  'visibility',
  'overflow',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'margin',
  'margin-top',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'padding',
  'padding-top',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-align',
  'text-decoration',
  'vertical-align',
  'line-height',
  'letter-spacing',
  'white-space',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-overflow',
  'border-radius',
  'border-color',
  'border-width',
  'border-style',
  'border-collapse',
  'box-shadow',
  'opacity',
  'z-index',
  'transform',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'viewBox',
  'preserveAspectRatio',
  'xmlns',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x1',
  'x2',
  'y1',
  'y2',
  'points',
  'd',
  'M',
  'L',
  'C',
  'Z',
  'gradientUnits',
  'offset',
  'stop-color',
  'stop-opacity',
  'patternUnits',
  'patternContentUnits',
  'filterUnits',
  'primitiveUnits',
  'maskUnits',
  'clip-path',
  'allowtransparency',
  'frameborder',
  'scrolling',
  'loading',
  'allow',
  'allowfullscreen',
  'referrerpolicy',
  'sandbox',
  'crossorigin',
  'usemap',
  'ismap',
  'alt',
  'title',
];

const ALLOWED_URL_ATTRS = [
  'href',
  'src',
  'action',
  'data',
  'poster',
  'xlink:href',
  'cite',
  'ping',
];

const MJML_TAGS = [
  'mjml',
  'mj-head',
  'mj-body',
  'mj-section',
  'mj-column',
  'mj-text',
  'mj-button',
  'mj-image',
  'mj-divider',
  'mj-spacer',
  'mj-wrapper',
  'mj-group',
  'mj-raw',
  'mj-social',
  'mj-social-element',
  'mj-navbar',
  'mj-navbar-link',
  'mj-carousel',
  'mj-carousel-image',
  'mj-accordion',
  'mj-accordion-element',
  'mj-accordion-title',
  'mj-accordion-text',
  'mj-head-attributes',
  'mj-head-style',
  'mj-head-breakpoint',
  'mj-head-font',
  'mj-head-preview',
  'mj-html',
];

export interface SanitizeConfig {
  allowIframes?: boolean;
  allowDataImages?: boolean;
  allowedHosts?: string[];
  maxLength?: number;
}

export interface SanitizedResult {
  html: string;
  warnings: string[];
  errors: string[];
}

export interface VariableValidationResult {
  valid: boolean;
  sanitized: Record<string, unknown>;
  errors: string[];
}

@Injectable()
export class XssSanitizer {
  private readonly logger = new Logger(XssSanitizer.name);
  private readonly window: any;
  private readonly purify: ReturnType<typeof DOMPurify>;
  private readonly urlValidator: UrlValidator;

  constructor() {
    this.window = new JSDOM('').window;
    this.purify = DOMPurify(this.window);
    this.urlValidator = new UrlValidator();
    this.configurePurify();
  }

  private configurePurify(): void {
    this.purify.setConfig({
      ALLOWED_TAGS: [...ALLOWED_TAGS, ...MJML_TAGS],
      ALLOWED_ATTR: [...ALLOWED_ATTRS, ...ALLOWED_URL_ATTRS],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto):|[^a-z]|[a-z+-]+:(?![^a-z+-]))/i,
      ALLOW_DATA_ATTR: false,
      ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'referrerpolicy'],
      FORBID_TAGS: [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'button',
        'select',
        'textarea',
        'label',
        'meta',
        'link',
        'base',
        'applet',
        'audio',
        'video',
        'source',
        'track',
        'canvas',
        'map',
        'area',
        'del',
        'ins',
        'samp',
        'kbd',
        'var',
        'noscript',
        'template',
      ],
      FORBID_ATTR: [
        'onerror',
        'onload',
        'onclick',
        'onmouseover',
        'onmouseout',
        'onmousedown',
        'onmouseup',
        'onfocus',
        'onblur',
        'onchange',
        'onsubmit',
        'onreset',
        'onkeydown',
        'onkeyup',
        'onkeypress',
        'ontouchstart',
        'ontouchend',
        'ontouchmove',
        'ontouchcancel',
      ],
    });
  }

  sanitize(html: string, config?: SanitizeConfig): SanitizedResult {
    const warnings: string[] = [];
    const errors: string[] = [];

    if (!html || typeof html !== 'string') {
      return {
        html: '',
        warnings: [],
        errors: ['Input is required and must be a string'],
      };
    }

    if (config?.maxLength && html.length > config.maxLength) {
      return {
        html: '',
        warnings: [],
        errors: [
          `Template exceeds maximum length of ${config.maxLength} bytes`,
        ],
      };
    }

    const maxLength = config?.maxLength ?? 51200;
    if (html.length > maxLength) {
      warnings.push(`Template truncated to ${maxLength} bytes`);
      html = html.substring(0, maxLength);
    }

    let sanitized = this.stripEventHandlers(html);
    sanitized = this.purify.sanitize(sanitized, {
      WHOLE_DOCUMENT: true,
      RETURN_DOM: false,
    });

    const urlValidation = this.urlValidator.validateAllUrls(sanitized);
    if (!urlValidation.valid) {
      for (const error of urlValidation.errors) {
        warnings.push(error);
      }
    }

    sanitized = this.enforceRelAttribute(sanitized);
    sanitized = this.sanitizeStyleAttributes(sanitized);

    if (sanitized.includes('<script')) {
      errors.push('Script tags detected and removed');
      sanitized = sanitized.replace(
        /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
        '',
      );
    }

    if (sanitized.includes('javascript:')) {
      errors.push('JavaScript protocol detected and blocked');
      sanitized = sanitized.replace(/javascript:/gi, 'blocked:');
    }

    if (sanitized.includes('onerror=') || sanitized.includes('onload=')) {
      errors.push('Event handlers detected and removed');
      sanitized = this.stripEventHandlers(sanitized);
    }

    return {
      html: sanitized,
      warnings,
      errors,
    };
  }

  sanitizeInline(html: string, config?: SanitizeConfig): string {
    const result = this.sanitize(html, config);
    return result.html;
  }

  private stripEventHandlers(html: string): string {
    return html.replace(/\s*on\w+\s*=\s*(['"])[^'"]*\1/gi, '');
  }

  private enforceRelAttribute(html: string): string {
    const parser = new this.window.DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const links = doc.querySelectorAll('a[target="_blank"]');

    links.forEach((link: any) => {
      const rel = link.getAttribute('rel') || '';
      if (!rel.includes('noopener')) {
        const newRel = [rel, 'noopener', 'noreferrer']
          .filter(Boolean)
          .join(' ');
        link.setAttribute('rel', newRel);
      }
    });

    return doc.body.innerHTML;
  }

  private sanitizeStyleAttributes(html: string): string {
    const parser = new this.window.DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const elements = doc.querySelectorAll('*');

    elements.forEach((el: any) => {
      const style = el.getAttribute('style');
      if (style) {
        const sanitizedStyle = this.sanitizeStyle(style);
        el.setAttribute('style', sanitizedStyle);
      }
    });

    return doc.body.innerHTML;
  }

  private sanitizeStyle(style: string): string {
    let sanitized = style.toLowerCase();

    const dangerousPatterns = [
      /url\s*\(\s*['"]?\s*javascript:/gi,
      /url\s*\(\s*['"]?\s*vbscript:/gi,
      /expression\s*\(/gi,
      /behavior\s*:/gi,
      /-moz-binding\s*:/gi,
      /behavior\s*:/gi,
    ];

    for (const pattern of dangerousPatterns) {
      sanitized = sanitized.replace(pattern, 'blocked(');
    }

    return sanitized;
  }

  validateVariables(vars: Record<string, unknown>): VariableValidationResult {
    const errors: string[] = [];
    const sanitized: Record<string, unknown> = {};

    if (!vars || typeof vars !== 'object') {
      return { valid: true, sanitized: {}, errors: [] };
    }

    for (const [key, value] of Object.entries(vars)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        errors.push(`Invalid variable name: ${key}`);
        continue;
      }

      if (typeof value === 'string') {
        const sanitizedValue = this.sanitizeInline(value);
        sanitized[key] = sanitizedValue;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        sanitized[key] = value;
      } else if (Array.isArray(value)) {
        sanitized[key] = value.map((item) =>
          typeof item === 'string' ? this.sanitizeInline(item) : item,
        );
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeObject(value as Record<string, unknown>);
      } else {
        sanitized[key] = value;
      }
    }

    return {
      valid: errors.length === 0,
      sanitized,
      errors,
    };
  }

  private sanitizeObject(
    obj: Record<string, unknown>,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        result[key] = this.sanitizeInline(value);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        result[key] = value;
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === 'string' ? this.sanitizeInline(item) : item,
        );
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.sanitizeObject(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  getAllowedTags(): string[] {
    return [...ALLOWED_TAGS];
  }

  getAllowedAttributes(): string[] {
    return [...ALLOWED_ATTRS];
  }
}
