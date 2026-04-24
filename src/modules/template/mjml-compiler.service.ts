import { Injectable, Logger } from '@nestjs/common';
import mjml2html from 'mjml';
import Handlebars from 'handlebars';
import juice from 'juice';
import { XssSanitizer } from './utils/xss-sanitizer';

export interface MjmlTemplate {
  source: string;
  compiled: HandlebarsTemplateDelegate;
  isMjml: boolean;
}

export interface MjmlCompilationResult {
  html: string;
  errors: string[];
  warnings: string[];
}

export interface MjmlValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export type TemplateFormat = 'mjml' | 'html';

interface MjmlError {
  line: number;
  message: string;
  tagName?: string;
  formattedMessage: string;
}

@Injectable()
export class MjmlCompilerService {
  private readonly logger = new Logger(MjmlCompilerService.name);
  private readonly cache = new Map<string, MjmlTemplate>();
  private readonly xssSanitizer: XssSanitizer;
  private readonly maxCacheSize = 100;

  constructor() {
    this.xssSanitizer = new XssSanitizer();
    this.registerHandlebarsHelpers();
  }

  detectFormat(source: string): TemplateFormat {
    const trimmed = source.trim();
    const lowerSource = trimmed.toLowerCase();

    if (
      lowerSource.startsWith('<mjml>') ||
      lowerSource.includes('<mj-') ||
      lowerSource.includes('mjml')
    ) {
      return 'mjml';
    }

    return 'html';
  }

  async compile(source: string, variables: Record<string, unknown>): Promise<string> {
    const format = this.detectFormat(source);

    if (format === 'mjml') {
      return this.compileMjml(source, variables);
    } else {
      return this.compileHtml(source, variables);
    }
  }

  async compileMjml(
    mjmlSource: string,
    variables: Record<string, unknown>,
  ): Promise<string> {
    let processedSource = mjmlSource;

    try {
      const handlebarsResult = this.precompileHandlebars(mjmlSource, variables);
      processedSource = handlebarsResult;
    } catch (err) {
      this.logger.warn('Handlebars pre-compilation failed, using raw MJML', {
        error: (err as Error).message,
      });
    }

    let compiled: string;
    try {
      const result = mjml2html(processedSource, {
        validationLevel: 'soft',
        minify: false,
        beautify: false,
        keepComments: false,
      });

      if (result.errors && result.errors.length > 0) {
        const errorMessages = result.errors
          .map((e: MjmlError) => e.formattedMessage || e.message)
          .join(', ');
        this.logger.warn('MJML compilation warnings', { warnings: errorMessages });
      }

      compiled = result.html;
    } catch (err) {
      this.logger.error('MJML compilation failed', {
        error: (err as Error).message,
      });
      throw new Error(`MJML compilation failed: ${(err as Error).message}`);
    }

    return compiled;
  }

  async compileHtml(
    htmlSource: string,
    variables: Record<string, unknown>,
  ): Promise<string> {
    let processedHtml = htmlSource;

    try {
      const handlebarsResult = this.precompileHandlebars(htmlSource, variables);
      processedHtml = handlebarsResult;
    } catch (err) {
      this.logger.warn('Handlebars compilation failed', {
        error: (err as Error).message,
      });
      throw new Error(`Handlebars compilation failed: ${(err as Error).message}`);
    }

    let inlinedHtml: string;
    try {
      inlinedHtml = juice(processedHtml, {
        removeStyleTags: false,
        preserveImportant: true,
        inlinePseudoElements: true,
      });
    } catch (err) {
      this.logger.warn('CSS inlining failed, using raw HTML', {
        error: (err as Error).message,
      });
      inlinedHtml = processedHtml;
    }

    return inlinedHtml;
  }

  validate(source: string): MjmlValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!source || typeof source !== 'string') {
      return {
        valid: false,
        errors: ['Template source is required'],
        warnings: [],
      };
    }

    if (source.length > 51200) {
      warnings.push('Template exceeds 50KB size limit');
    }

    const format = this.detectFormat(source);

    if (format === 'mjml') {
      try {
        const result = mjml2html(source, {
          validationLevel: 'strict',
          minify: false,
        });

        if (result.errors && result.errors.length > 0) {
          for (const error of result.errors) {
            const mjmlError = error as MjmlError;
            errors.push(mjmlError.formattedMessage || mjmlError.message);
          }
        }
      } catch (err) {
        errors.push(`MJML validation failed: ${(err as Error).message}`);
      }
    } else {
      try {
        Handlebars.compile(source);
      } catch (err) {
        errors.push(`Handlebars syntax error: ${(err as Error).message}`);
      }
    }

    const sanitized = this.xssSanitizer.sanitize(source, { maxLength: 51200 });
    if (sanitized.errors.length > 0) {
      errors.push(...sanitized.errors);
    }
    if (sanitized.warnings.length > 0) {
      warnings.push(...sanitized.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  getCompiledTemplate(source: string): MjmlTemplate {
    const cacheKey = this.hashSource(source);

    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey)!;
    }

    const isMjml = this.detectFormat(source) === 'mjml';
    let compiled: HandlebarsTemplateDelegate;

    try {
      compiled = Handlebars.compile(source);
    } catch (err) {
      this.logger.error('Failed to compile template', {
        error: (err as Error).message,
      });
      throw new Error(`Template compilation failed: ${(err as Error).message}`);
    }

    const template: MjmlTemplate = {
      source,
      compiled,
      isMjml,
    };

    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(cacheKey, template);
    return template;
  }

  clearCache(): void {
    this.cache.clear();
    this.logger.log('Template cache cleared');
  }

  getCacheSize(): number {
    return this.cache.size;
  }

  private precompileHandlebars(
    source: string,
    variables: Record<string, unknown>,
  ): string {
    const template = this.getCompiledTemplate(source);
    return template.compiled(variables);
  }

  private hashSource(source: string): string {
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      const char = source.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  private registerHandlebarsHelpers(): void {
    Handlebars.registerHelper('money', (amount: number, symbol = 'USDC') => {
      if (typeof amount !== 'number') {
        return `${amount} ${symbol}`;
      }
      return `${amount.toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })} ${symbol}`;
    });

    Handlebars.registerHelper('truncateAddress', (address: string, chars = 4) => {
      if (!address || typeof address !== 'string') {
        return '';
      }
      if (address.length <= chars * 2 + 3) {
        return address;
      }
      return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
    });

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

    Handlebars.registerHelper('json', (context: unknown) => {
      return JSON.stringify(context, null, 2);
    });

    Handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
    Handlebars.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
    Handlebars.registerHelper('gt', (a: number, b: number) => a > b);
    Handlebars.registerHelper('lt', (a: number, b: number) => a < b);
    Handlebars.registerHelper('gte', (a: number, b: number) => a >= b);
    Handlebars.registerHelper('lte', (a: number, b: number) => a <= b);

    Handlebars.registerHelper('and', (...args: unknown[]) => {
      args.pop();
      return args.every(Boolean);
    });

    Handlebars.registerHelper('or', (...args: unknown[]) => {
      args.pop();
      return args.some(Boolean);
    });

    Handlebars.registerHelper('not', (value: unknown) => !value);

    Handlebars.registerHelper('default', (value: unknown, defaultValue: unknown) => {
      return value ?? defaultValue;
    });
  }
}
