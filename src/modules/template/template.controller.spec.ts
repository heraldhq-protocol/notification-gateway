import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, NotFoundException } from '@nestjs/common';

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

jest.mock('./template.service', () => ({
  TemplateService: jest.fn().mockImplementation(() => ({
    validateCustomTemplate: jest.fn(),
  })),
}));

jest.mock('juice', () => ({
  default: jest.fn((html: string) => html),
  __esModule: true,
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mocked-uuid'),
}));

import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard } from '../../common/guards/scope.guard';
import { TemplateController } from './template.controller';
import { TemplateService } from './template.service';
import { PrismaService } from '../../database/prisma.service';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';

const mockPrisma = {
  notificationTemplate: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  notificationTemplateVersion: {
    create: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
};

const mockTemplateService = {
  validateCustomTemplate: jest.fn(),
};

const mockProtocol: AuthenticatedProtocol = {
  protocolId: 'proto-1',
  protocolPubkey: 'TestProtocolPubkey123456789',
  apiKeyId: 'key-1',
  tier: 1,
  scopes: ['notify:write', 'admin'],
  environment: 'live',
  isActive: true,
  name: 'TestProtocol',
};

const mockGrowthTier: AuthenticatedProtocol = { ...mockProtocol, tier: 1 };
const mockDevTier: AuthenticatedProtocol = { ...mockProtocol, tier: 0 };

describe('TemplateController', () => {
  let controller: TemplateController;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [TemplateController],
      providers: [
        { provide: PrismaService, useValue: mockPrisma },
        { provide: TemplateService, useValue: mockTemplateService },
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .overrideGuard(ScopeGuard)
      .useValue({ canActivate: jest.fn(() => true) })
      .compile();

    controller = module.get<TemplateController>(TemplateController);
  });

  describe('createEmailTemplate', () => {
    const createDto = {
      name: 'My Custom Template',
      category: 'defi',
      subjectTemplate: '{{subject}} - MyApp',
      htmlSource: '<html><body><h1>{{title}}</h1></body></html>',
      textSource: 'Plain text version',
      isDefault: true,
    };

    const createDtoNoDefault = { ...createDto, isDefault: false };

    it('should create a template and return templateId', async () => {
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: true,
        compiledHtml: '<html><body><h1>{{title}}</h1></body></html>',
      });
      mockPrisma.notificationTemplate.create.mockResolvedValue({
        id: 'new-tmpl-id',
      });

      const result = await controller.createEmailTemplate(
        mockGrowthTier,
        createDtoNoDefault,
      );

      expect(result.success).toBe(true);
      expect(result.templateId).toBe('new-tmpl-id');
    });

    it('should reject templates for developer tier (0)', async () => {
      await expect(
        controller.createEmailTemplate(mockDevTier, createDtoNoDefault),
      ).rejects.toThrow(HttpException);
    });

    it('should unset existing defaults when isDefault=true', async () => {
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: true,
        compiledHtml: '<html><body><h1>{{title}}</h1></body></html>',
      });
      mockPrisma.notificationTemplate.create.mockResolvedValue({
        id: 'tmpl-id',
      });

      await controller.createEmailTemplate(mockGrowthTier, createDto);

      expect(mockPrisma.notificationTemplate.updateMany).toHaveBeenCalledWith({
        where: { protocolId: 'proto-1', category: 'defi' },
        data: { isDefault: false },
      });
    });

    it('should validate and sanitize HTML', async () => {
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: true,
        compiledHtml: '<html><body><h1>{{title}}</h1></body></html>',
      });
      mockPrisma.notificationTemplate.create.mockResolvedValue({
        id: 'tmpl-id',
      });

      await controller.createEmailTemplate(mockGrowthTier, createDtoNoDefault);

      expect(mockTemplateService.validateCustomTemplate).toHaveBeenCalled();
    });

    it('should reject invalid HTML', async () => {
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: false,
        error: 'Template syntax error: ...',
      });

      await expect(
        controller.createEmailTemplate(mockGrowthTier, createDtoNoDefault),
      ).rejects.toThrow(HttpException);
    });
  });

  describe('listEmailTemplates', () => {
    it('should return list of active templates', async () => {
      mockPrisma.notificationTemplate.findMany.mockResolvedValue([
        { id: 'tmpl-1', name: 'Template 1', category: 'defi' },
        { id: 'tmpl-2', name: 'Template 2', category: 'marketing' },
      ]);

      const result = await controller.listEmailTemplates(mockGrowthTier);

      expect(result.data).toHaveLength(2);
      expect(mockPrisma.notificationTemplate.findMany).toHaveBeenCalledWith({
        where: { protocolId: 'proto-1', isActive: true },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('getEmailTemplate', () => {
    it('should return template by id', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue({
        id: 'tmpl-1',
        name: 'My Template',
        protocolId: 'proto-1',
      });

      const result = await controller.getEmailTemplate(
        mockGrowthTier,
        'tmpl-1',
      );

      expect(result.id).toBe('tmpl-1');
      expect(result.name).toBe('My Template');
    });

    it('should throw 404 when template not found', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue(null);

      await expect(
        controller.getEmailTemplate(mockGrowthTier, 'unknown-id'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateEmailTemplate', () => {
    const existingTemplate = {
      id: 'tmpl-1',
      protocolId: 'proto-1',
      isActive: true,
      category: 'defi',
      version: 1,
    };

    const updateDto = {
      name: 'Updated Template',
      subjectTemplate: 'New {{subject}}',
      htmlSource: '<html><body><h1>Updated</h1></body></html>',
      isDefault: true,
    };

    it('should update template and bump version', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue(
        existingTemplate,
      );
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: true,
        compiledHtml: '<html><body><h1>Updated</h1></body></html>',
      });
      mockPrisma.notificationTemplateVersion.count.mockResolvedValue(3);
      mockPrisma.notificationTemplate.update.mockResolvedValue({});

      const result = await controller.updateEmailTemplate(
        mockGrowthTier,
        'tmpl-1',
        updateDto,
      );

      expect(result.success).toBe(true);
      expect(
        mockPrisma.notificationTemplateVersion.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            templateId: 'tmpl-1',
            version: 2,
          }),
        }),
      );
    });

    it('should reject update for developer tier', async () => {
      await expect(
        controller.updateEmailTemplate(mockDevTier, 'tmpl-1', updateDto),
      ).rejects.toThrow(HttpException);
    });

    it('should throw 404 when template does not exist', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue(null);

      await expect(
        controller.updateEmailTemplate(mockGrowthTier, 'unknown', updateDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should prune old versions when exceeding 10', async () => {
      const manyVersions = Array.from({ length: 12 }, (_, i) => ({
        id: `v-${i}`,
        version: i + 1,
      }));

      mockPrisma.notificationTemplate.findFirst.mockResolvedValue(
        existingTemplate,
      );
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: true,
        compiledHtml: '<html><body><h1>Updated</h1></body></html>',
      });
      mockPrisma.notificationTemplateVersion.count.mockResolvedValue(12);
      mockPrisma.notificationTemplateVersion.findMany.mockResolvedValue(
        manyVersions.slice(0, 2),
      );
      mockPrisma.notificationTemplate.update.mockResolvedValue({});

      await controller.updateEmailTemplate(mockGrowthTier, 'tmpl-1', updateDto);

      expect(
        mockPrisma.notificationTemplateVersion.deleteMany,
      ).toHaveBeenCalled();
    });

    it('should unset previous defaults when isDefault=true', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue(
        existingTemplate,
      );
      mockTemplateService.validateCustomTemplate.mockReturnValue({
        valid: true,
        compiledHtml: '<html><body><h1>Updated</h1></body></html>',
      });
      mockPrisma.notificationTemplateVersion.count.mockResolvedValue(2);
      mockPrisma.notificationTemplate.update.mockResolvedValue({});

      await controller.updateEmailTemplate(mockGrowthTier, 'tmpl-1', {
        isDefault: true,
      });

      expect(mockPrisma.notificationTemplate.updateMany).toHaveBeenCalledWith({
        where: { protocolId: 'proto-1', category: 'defi' },
        data: { isDefault: false },
      });
    });
  });

  describe('deleteEmailTemplate', () => {
    it('should soft-delete template', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue({
        id: 'tmpl-1',
        protocolId: 'proto-1',
        isActive: true,
      });

      const result = await controller.deleteEmailTemplate(
        mockGrowthTier,
        'tmpl-1',
      );

      expect(result.success).toBe(true);
      expect(mockPrisma.notificationTemplate.update).toHaveBeenCalledWith({
        where: { id: 'tmpl-1' },
        data: { isActive: false },
      });
    });

    it('should throw 404 when template not found', async () => {
      mockPrisma.notificationTemplate.findFirst.mockResolvedValue(null);

      await expect(
        controller.deleteEmailTemplate(mockGrowthTier, 'unknown'),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
