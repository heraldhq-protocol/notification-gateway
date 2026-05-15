import { Test, TestingModule } from '@nestjs/testing';

jest.mock('./utils/xss-sanitizer', () => ({
  XssSanitizer: jest.fn().mockImplementation(() => ({
    sanitize: jest.fn((html: string, _opts?: any) => ({
      html,
      errors: [] as string[],
      warnings: [] as string[],
    })),
  })),
}));

import { MjmlCompilerService } from './mjml-compiler.service';

const VALID_MJML = `<mjml>
  <mj-head>
    <mj-title>{{subject}}</mj-title>
    <mj-style inline="inline">h1 { color: red; }</mj-style>
  </mj-head>
  <mj-body>
    <mj-section>
      <mj-column>
        <mj-text font-size="20px">{{title}}</mj-text>
        <mj-divider border-color="#00C896" />
        <mj-text>{{{body}}}</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

const VALID_HTML = `<!doctype html>
<html><head><title>{{subject}}</title></head>
<body><h1>{{title}}</h1><p>{{body}}</p></body></html>`;

describe('MjmlCompilerService', () => {
  let service: MjmlCompilerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MjmlCompilerService],
    }).compile();

    service = module.get<MjmlCompilerService>(MjmlCompilerService);
  });

  describe('detectFormat', () => {
    it('should detect MJML from <mjml> tag', () => {
      expect(service.detectFormat(VALID_MJML)).toBe('mjml');
    });

    it('should detect MJML from <mj- elements', () => {
      const input =
        '<mj-section><mj-column><mj-text>Hello</mj-text></mj-column></mj-section>';
      expect(service.detectFormat(input)).toBe('mjml');
    });

    it('should default to HTML for standard HTML', () => {
      expect(service.detectFormat(VALID_HTML)).toBe('html');
    });

    it('should default to HTML for empty input', () => {
      expect(service.detectFormat('')).toBe('html');
    });
  });

  describe('compile', () => {
    it('should compile MJML to responsive HTML', async () => {
      const result = await service.compile(VALID_MJML, {
        subject: 'Test',
        title: 'Hello World',
        body: 'Content here',
      });

      expect(result).toContain('Hello World');
      expect(result).toContain('Content here');
      expect(result).toContain('<!doctype html');
    });

    it('should compile HTML with Handlebars and inline CSS', async () => {
      const result = service.compileHtml(VALID_HTML, {
        subject: 'Test',
        title: 'Hello',
        body: 'World',
      });

      expect(result).toContain('Hello');
      expect(result).toContain('World');
    });

    it('should throw on invalid Handlebars in HTML mode', () => {
      expect(() =>
        service.compileHtml('<html>{{#invalid}}<p>Test</p>', {}),
      ).toThrow('Handlebars compilation failed');
    });
  });

  describe('validate', () => {
    it('should validate valid MJML', async () => {
      const result = await service.validate(VALID_MJML);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate valid HTML', async () => {
      const result = await service.validate(VALID_HTML);
      expect(result.valid).toBe(true);
    });

    it('should reject empty source', async () => {
      const result = await service.validate('');
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Template source is required');
    });

    it('should warn on oversized template', async () => {
      const oversized = 'x'.repeat(60000);
      const result = await service.validate(oversized);
      expect(result.warnings).toContain('Template exceeds 50KB size limit');
    });

    it('should handle Handlebars templates gracefully', async () => {
      const result = await service.validate('<html><body>{{title}}</body></html>');
      expect(result.valid).toBe(true);
    });
  });

  describe('getCompiledTemplate', () => {
    it('should cache compiled templates', () => {
      const first = service.getCompiledTemplate(VALID_HTML);
      const second = service.getCompiledTemplate(VALID_HTML);

      expect(first).toBe(second);
    });

    it('should evict oldest when cache exceeds max size', () => {
      const max = 100;
      for (let i = 0; i < max + 5; i++) {
        service.getCompiledTemplate(`template-${i}`);
      }

      expect(service.getCacheSize()).toBeLessThanOrEqual(max);
    });
  });

  describe('clearCache', () => {
    it('should clear the template cache', () => {
      service.getCompiledTemplate(VALID_HTML);
      expect(service.getCacheSize()).toBeGreaterThan(0);

      service.clearCache();
      expect(service.getCacheSize()).toBe(0);
    });
  });
});
