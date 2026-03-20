import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import mjml2html from 'mjml';
import Handlebars from 'handlebars';
import juice from 'juice';
import { fileURLToPath } from 'url';

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
 * TemplateService — compiles MJML templates into cross-client HTML emails.
 *
 * Pipeline: Handlebars (variable injection) → MJML (responsive email DSL) → juice (CSS inlining)
 *
 * Templates are loaded from the filesystem (templates/ directory).
 * Custom protocol templates are supported for Scale/Enterprise tiers.
 */
@Injectable()
export class TemplateService {
  private readonly logger = new Logger(TemplateService.name);
  private readonly templateDir: string;

  constructor() {
    // Resolve template directory relative to this file
    this.templateDir = path.join(__dirname, 'templates');
    this.registerHelpers();
  }

  /**
   * Render a complete email with HTML + plain text parts.
   */
  async render(params: RenderParams): Promise<RenderedEmail> {
    const { template, variables } = params;

    let mjmlSource: string;
    try {
      mjmlSource = await this.loadSystemTemplate(template);
    } catch {
      // Fallback to defi-alert if template not found
      this.logger.warn(`Template "${template}" not found, using defi-alert`);
      mjmlSource = await this.loadSystemTemplate('defi-alert');
    }

    // 1. Handlebars: inject variables into MJML source
    const compiled = Handlebars.compile(mjmlSource);
    const processedMjml = compiled(variables);

    // 2. MJML: compile to responsive HTML
    const { html, errors } = mjml2html(processedMjml, {
      keepComments: false,
      minify: true,
    });

    if (errors.length > 0) {
      this.logger.warn('MJML compilation warnings', {
        template,
        errors: errors.map((e) => e.message),
      });
    }

    // 3. Juice: inline CSS for email client compatibility
    const inlinedHtml = juice(html, { removeStyleTags: false });

    // 4. Plain text fallback
    const plainText = await this.renderPlainText(template, variables);

    return {
      html: inlinedHtml,
      text: plainText,
      subject: variables.subject as string,
    };
  }

  private async loadSystemTemplate(name: string): Promise<string> {
    const templatePath = path.join(this.templateDir, name, 'index.mjml');
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
      // Generate a simple plain text version from variables
      return [
        `${vars.protocolName}: ${vars.subject}`,
        '─'.repeat(60),
        '',
        vars.body,
        '',
        '─'.repeat(60),
        `Unsubscribe: ${vars.unsubscribeUrl}`,
        '',
        '🔒 Privacy: Your email is protected by Herald.',
        'herald.xyz · notify.herald.xyz',
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
          defi: '#D63031',
          governance: '#5B35D5',
          system: '#E8920A',
          marketing: '#27AE60',
        })[category] ?? '#64748B',
    );
    Handlebars.registerHelper('repeat', (str: string, count: number) =>
      str.repeat(count),
    );
  }
}
