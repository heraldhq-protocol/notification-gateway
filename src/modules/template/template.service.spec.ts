import { Test, TestingModule } from '@nestjs/testing';

jest.mock('marked', () => ({
  marked: {
    parse: jest.fn((text: string) => text),
    options: jest.fn(),
    setOptions: jest.fn(),
    use: jest.fn(),
    defaults: {},
    getDefaults: jest.fn(),
    walkTokens: jest.fn(),
    parseInline: jest.fn(),
    Lexer: class {},
    Parser: class {},
    Renderer: class {},
    Tokenizer: class {},
    TextRenderer: class {},
    Hooks: class {},
  },
}));

jest.mock('juice', () => ({
  default: jest.fn((html: string) => html),
  __esModule: true,
}));

jest.mock('./utils/xss-sanitizer', () => ({
  XssSanitizer: jest.fn().mockImplementation(() => ({
    sanitize: jest.fn((html: string, _opts?: any) => ({
      html,
      errors: [] as string[],
      warnings: [] as string[],
    })),
  })),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      readFile: jest.fn(),
    },
  };
});

import fs from 'fs';
import { TemplateService } from './template.service';
import { PrismaService } from '../../database/prisma.service';

const mockPrisma = {
  notificationTemplate: {
    findFirst: jest.fn(),
  },
};

const CUSTOM_TEMPLATE = `<!doctype html>
<html><body style="background:{{bgColor}};"><h1>{{customTitle}}</h1><p>{{body}}</p></body></html>`;

describe('TemplateService', () => {
  let service: TemplateService;

  beforeEach(async () => {
    jest.clearAllMocks();

    (fs.promises.readFile as jest.Mock).mockImplementation(
      async (filePath: string) => {
        if (filePath.includes('defi-alert') && filePath.endsWith('index.hbs')) {
          return '<html><body><h1>{{subject}}</h1><p>{{body}}</p></body></html>';
        }
        if (filePath.endsWith('index.hbs')) {
          return '<html><body><h1>{{subject}}</h1><p>{{body}}</p></body></html>';
        }
        throw new Error('ENOENT');
      },
    );

    mockPrisma.notificationTemplate.findFirst.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TemplateService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<TemplateService>(TemplateService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('render', () => {
    it('should render system template with variables', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: {
          subject: 'Test Subject',
          body: 'Hello world',
          protocolName: 'TestProtocol',
        },
      });

      expect(result.html).toContain('Test Subject');
      expect(result.html).toContain('Hello world');
      expect(result.text).toContain('TestProtocol');
      expect(result.subject).toBe('Test Subject');
    });

    it('should load custom template when templateId and protocolId provided', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue({
        id: 'tmpl-1',
        htmlSource: CUSTOM_TEMPLATE,
      });

      const result = await service.render({
        template: 'defi-alert',
        templateId: 'tmpl-1',
        protocolId: 'proto-1',
        variables: {
          customTitle: 'Custom Alert',
          body: 'Custom body',
          bgColor: '#ff0000',
          subject: 'S',
        },
      });

      expect(result.html).toContain('Custom Alert');
      expect(result.html).toContain('Custom body');
      expect(result.html).toContain('background:#ff0000');
    });

    it('should load protocol default template when no custom templateId', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue({
        id: 'default-tmpl',
        htmlSource:
          '<html><body><h1>{{subject}}</h1><p>{{body}}</p></body></html>',
      });

      const result = await service.render({
        template: 'defi-alert',
        protocolId: 'proto-1',
        variables: { subject: 'Default', body: 'Default body' },
      });

      expect(result.html).toContain('Default');
      expect(result.html).toContain('Default body');
    });

    it('should fall back to defi-alert when template not found on filesystem', async () => {
      (fs.promises.readFile as jest.Mock).mockRejectedValue(
        new Error('ENOENT'),
      );

      const result = await service.render({
        template: 'nonexistent-template',
        variables: { subject: 'Fallback', body: 'Fallback body' },
      });

      expect(result.html).toContain('Fallback');
      expect(result.html).toContain('Fallback body');
    });

    it('should return minimal fallback when even defi-alert is missing', async () => {
      (fs.promises.readFile as jest.Mock).mockRejectedValue(
        new Error('ENOENT'),
      );

      const result = await service.render({
        template: 'nonexistent',
        variables: {
          subject: 'Last Resort',
          body: 'Body',
          protocolName: 'App',
        },
      });

      expect(result.html).toContain('Last Resort');
      expect(result.html).toContain('Body');
    });

    it('should inject full Herald footer for tier 0 (developer)', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: { subject: 'S', body: 'B', protocolName: 'P' },
        tier: 0,
      });

      expect(result.html).toContain('◈ Herald');
      expect(result.html).toContain('Privacy-preserving DeFi notifications');
      expect(result.html).toContain('Unsubscribe');
    });

    it('should inject small footer for tier 1 (growth)', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: { subject: 'S', body: 'B', protocolName: 'P' },
        tier: 1,
      });

      expect(result.html).toContain('Delivered securely via');
      expect(result.html).toContain('Unsubscribe');
    });

    it('should inject minimal footer for tier 2 (scale)', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: { subject: 'S', body: 'B', protocolName: 'P' },
        tier: 2,
      });

      expect(result.html).toContain('◈ Herald');
      expect(result.html).toContain('Unsubscribe');
    });

    it('should inject enterprise footer for tier 3', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: { subject: 'S', body: 'B', protocolName: 'P' },
        tier: 3,
      });

      expect(result.html).toContain('Herald');
      expect(result.html).toContain('Unsubscribe');
    });

    it('should skip footer injection when template has .footer-brand', async () => {
      (fs.promises.readFile as jest.Mock).mockResolvedValue(
        '<html><body><div class="footer-brand">Existing Footer</div></body></html>',
      );

      const result = await service.render({
        template: 'defi-alert',
        variables: { subject: 'S', body: 'B', protocolName: 'P' },
        tier: 0,
      });

      expect(result.html).toContain('footer-brand');
      expect(result.html).not.toContain('Privacy-preserving');
    });

    it('should generate plain text fallback', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: {
          subject: 'Alert',
          body: 'Something happened',
          protocolName: 'MyApp',
          unsubscribeUrl: 'https://example.com/unsub',
        },
      });

      expect(result.text).toContain('MyApp');
      expect(result.text).toContain('Alert');
      expect(result.text).toContain('Something happened');
      expect(result.text).toContain('https://example.com/unsub');
    });

    it('should process markdown links in body', async () => {
      const result = await service.render({
        template: 'defi-alert',
        variables: {
          subject: 'S',
          body: 'Click [here](https://example.com) for details',
          protocolName: 'P',
        },
      });

      expect(result.html).toContain('https://example.com');
    });
  });

  describe('validateCustomTemplate', () => {
    it('should reject templates for tier 0 (developer)', () => {
      const result = service.validateCustomTemplate('<html></html>', 0);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Growth plan');
    });

    it('should accept valid Handlebars HTML for tier >= 1', () => {
      const result = service.validateCustomTemplate(
        '<html><body><h1>{{title}}</h1></body></html>',
        1,
      );
      expect(result.valid).toBe(true);
      expect(result.compiledHtml).toBeDefined();
    });

    it('should strip XSS event handlers', () => {
      const result = service.validateCustomTemplate(
        '<html><body onclick="alert(1)"><p>Hello</p></body></html>',
        1,
      );
      expect(result.valid).toBe(true);
      expect(result.compiledHtml).not.toContain('onclick');
    });
  });
});
