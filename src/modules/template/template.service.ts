import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import Handlebars from 'handlebars';
import juice from 'juice';
import { marked } from 'marked';

export interface RenderParams {
  template: string;
  variables: Record<string, unknown>;
  protocolId?: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
  subject: string;
}

/**
 * TemplateService — compiles Handlebars templates into cross-client HTML emails.
 *
 * Pipeline: Handlebars (variable injection) → juice (CSS inlining)
 *
 * Templates are loaded from the filesystem (templates/ directory).
 * Custom protocol templates are supported for Scale/Enterprise tiers.
 */
@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);
  private readonly templateDir: string;

  constructor() {
    // Resolve template directory robustly for both local development and production
    // Local: src/modules/template/templates
    // Prod: dist/modules/template/templates
    const isProd = process.env.NODE_ENV === 'production';
    this.templateDir = isProd
      ? path.join(process.cwd(), 'dist', 'modules', 'template', 'templates')
      : path.join(process.cwd(), 'src', 'modules', 'template', 'templates');

    this.logger.log(`Template directory initialized at: ${this.templateDir}`);
    this.registerHelpers();
  }

  /**
   * Render a complete email with HTML + plain text parts.
   */
  async render(params: RenderParams): Promise<RenderedEmail> {
    const { template, variables } = params;

    let hbsSource: string;
    try {
      hbsSource = await this.loadSystemTemplate(template);
    } catch {
      // Fallback to defi-alert if template not found
      this.logger.warn(`Template "${template}" not found, using defi-alert`);
      try {
        hbsSource = await this.loadSystemTemplate('defi-alert');
      } catch {
        // Absolute fallback to base.hbs if even defi-alert is missing
        this.logger.error('Failed to load fallback template defi-alert');
        const basePath = path.join(this.templateDir, 'base.hbs');
        hbsSource = await fs.promises.readFile(basePath, 'utf-8');
      }
    }

    // 1. Handlebars: inject variables into HTML source
    const compiled = Handlebars.compile(hbsSource);
    const htmlWithVars = compiled(variables);

    // 2. Juice: inline CSS for email client compatibility
    const inlinedHtml = juice(htmlWithVars, { removeStyleTags: false });

    // 3. Plain text fallback
    const plainText = await this.renderPlainText(template, variables);

    return {
      html: inlinedHtml,
      text: plainText,
      subject: (variables.subject as string) || 'Notification from Herald',
    };
  }

  private async loadSystemTemplate(name: string): Promise<string> {
    const templatePath = path.join(this.templateDir, name, 'index.hbs');
    this.logger.debug(`Loading template: ${templatePath}`);
    return fs.promises.readFile(templatePath, 'utf-8');
  }

  private async renderPlainText(
    template: string,
    vars: Record<string, unknown>,
  ): Promise<string> {
    try {
      const hbsPath = path.join(this.templateDir, template, 'plain.hbs');
      const source = await fs.promises.readFile(hbsPath, 'utf-8');
      const compiled = Handlebars.compile(source);
      return compiled(vars);
    } catch {
      // Generate a refined plain text version for deliverability
      const protocol = (vars.protocolName as string) || 'Herald';
      const subject = (vars.subject as string) || 'Notification';
      const recipient =
        (vars.recipientAddress as string) || 'Encrypted Identity';

      return [
        'HERALD NOTIFICATION INFRASTRUCTURE',
        '================================',
        '',
        `Source Protocol: ${protocol}`,
        `Subject: ${subject}`,
        '',
        '--------------------------------',
        '',
        vars.body,
        '',
        '--------------------------------',
        '',
        'Zero-PII delivery protocol • ' +
          protocol +
          ' cannot access recipient identity • Relayed by Herald Network',
        '',
        '--------------------------------',
        '',
        'Delivered via Herald API | https://useherald.xyz',
        `Unsubscribe: ${vars.unsubscribeUrl}`,
        `Recipient: ${recipient}`,
      ].join('\n');
    }
  }

  private registerHelpers(): void {
    Handlebars.registerHelper('truncate', (str: string, len: number) =>
      str?.length > len ? str.slice(0, len) + '...' : str,
    );
    Handlebars.registerHelper('formatDate', (ts: number) =>
      new Date(ts * 1000).toISOString(),
    );
    Handlebars.registerHelper(
      'categoryColor',
      (category: string) =>
        ({
          defi: '#00C896',
          governance: '#8B5CF6',
          system: '#F59E0B',
          marketing: '#10B981',
          security: '#EF4444',
        })[category] ?? '#00C896',
    );
    Handlebars.registerHelper(
      'categoryClass',
      (category: string) =>
        ({
          defi: 'defi',
          governance: 'governance',
          system: 'system',
          marketing: 'marketing',
          security: 'security',
          liquidation: 'liquidation',
          yield: 'yield',
        })[category] ?? 'defi',
    );
    Handlebars.registerHelper('markdown', (content: string) => {
      if (!content) return '';
      // Convert markdown to HTML and return as safe string
      return new Handlebars.SafeString(
        marked.parse(content, { gfm: true }) as string,
      );
    });
    Handlebars.registerHelper('repeat', (str: string, count: number) =>
      str.repeat(count),
    );
  }
}
