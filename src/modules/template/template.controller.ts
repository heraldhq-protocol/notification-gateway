import {
  Controller,
  Post,
  Get,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PrismaService } from '../../database/prisma.service';
import { TemplateService } from './template.service';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ScopeGuard, RequiredScopes } from '../../common/guards/scope.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { v4 as uuidv4 } from 'uuid';

/**
 * TemplateController — manage custom email and Telegram templates.
 * Requires Growth tier (tier >= 1) for email, and Scale tier (tier >= 2) for Telegram.
 */
@ApiTags('Templates')
@ApiBearerAuth()
@UseGuards(AuthGuard, ScopeGuard)
@RequiredScopes('admin')
@Controller('v1/templates')
export class TemplateController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templateService: TemplateService,
  ) {}

  @Post('email')
  @ApiOperation({ summary: 'Create custom email template (Growth+)' })
  async createEmailTemplate(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Body() body: any,
  ) {
    if (protocol.tier < 1) {
      throw new HttpException(
        'Custom email templates require Growth tier or higher',
        HttpStatus.FORBIDDEN,
      );
    }

    const {
      name,
      category,
      subjectTemplate,
      htmlSource,
      textSource,
      isDefault,
    } = body;

    // Validate and sanitize HTML
    const validation = this.templateService.validateCustomTemplate(
      htmlSource || '',
      protocol.tier,
    );

    if (!validation.valid) {
      throw new HttpException(
        validation.error || 'Invalid template',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Default templates mean we need to unset any existing defaults for this category
    if (isDefault) {
      await this.prisma.notificationTemplate.updateMany({
        where: { protocolId: protocol.protocolId, category },
        data: { isDefault: false },
      });
    }

    const template = await this.prisma.notificationTemplate.create({
      data: {
        id: uuidv4(),
        protocolId: protocol.protocolId,
        name,
        category,
        subjectTemplate,
        htmlSource: validation.compiledHtml, // Sanitized
        textSource,
        isDefault: isDefault ?? false,
      },
    });

    return { success: true, templateId: template.id };
  }

  @Get('email')
  @ApiOperation({ summary: 'List custom email templates' })
  async listEmailTemplates(@ApiKey() protocol: AuthenticatedProtocol) {
    const templates = await this.prisma.notificationTemplate.findMany({
      where: { protocolId: protocol.protocolId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    return { data: templates };
  }

  @Get('email/:id')
  @ApiOperation({ summary: 'Get a single custom email template' })
  async getEmailTemplate(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Param('id') id: string,
  ) {
    const template = await this.prisma.notificationTemplate.findFirst({
      where: { id, protocolId: protocol.protocolId, isActive: true },
    });
    if (!template) {
      throw new NotFoundException('Template not found');
    }
    return template;
  }

  @Put('email/:id')
  @ApiOperation({
    summary: 'Update a custom email template (creates new version)',
  })
  async updateEmailTemplate(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    if (protocol.tier < 1) {
      throw new HttpException(
        'Custom email templates require Growth tier or higher',
        HttpStatus.FORBIDDEN,
      );
    }

    const existing = await this.prisma.notificationTemplate.findFirst({
      where: { id, protocolId: protocol.protocolId, isActive: true },
    });
    if (!existing) {
      throw new NotFoundException('Template not found');
    }

    const updates: any = { updatedAt: new Date() };
    if (body.name !== undefined) updates.name = body.name;
    if (body.subjectTemplate !== undefined)
      updates.subjectTemplate = body.subjectTemplate;
    if (body.previewText !== undefined) updates.previewText = body.previewText;
    if (body.heraldFooter !== undefined)
      updates.heraldFooter = body.heraldFooter;
    if (body.isDefault !== undefined) {
      if (body.isDefault) {
        await this.prisma.notificationTemplate.updateMany({
          where: {
            protocolId: protocol.protocolId,
            category: existing.category,
          },
          data: { isDefault: false },
        });
      }
      updates.isDefault = body.isDefault;
    }

    if (body.htmlSource) {
      const validation = this.templateService.validateCustomTemplate(
        body.htmlSource,
        protocol.tier,
      );
      if (!validation.valid) {
        throw new HttpException(
          validation.error || 'Invalid template HTML',
          HttpStatus.BAD_REQUEST,
        );
      }
      const sanitizedHtml = validation.compiledHtml!;
      updates.htmlSource = sanitizedHtml;
      updates.version = existing.version + 1;

      await this.prisma.notificationTemplateVersion.create({
        data: {
          id: uuidv4(),
          templateId: existing.id,
          version: existing.version + 1,
          htmlSource: sanitizedHtml,
          subjectTemplate: body.subjectTemplate ?? existing.subjectTemplate,
        },
      });

      const versionCount = await this.prisma.notificationTemplateVersion.count({
        where: { templateId: existing.id },
      });
      if (versionCount > 10) {
        const oldest = await this.prisma.notificationTemplateVersion.findMany({
          where: { templateId: existing.id },
          orderBy: { version: 'asc' },
          take: versionCount - 10,
        });
        await this.prisma.notificationTemplateVersion.deleteMany({
          where: { id: { in: oldest.map((v) => v.id) } },
        });
      }
    }

    await this.prisma.notificationTemplate.update({
      where: { id },
      data: updates,
    });

    return { success: true };
  }

  @Delete('email/:id')
  @ApiOperation({ summary: 'Soft-delete a custom email template' })
  async deleteEmailTemplate(
    @ApiKey() protocol: AuthenticatedProtocol,
    @Param('id') id: string,
  ) {
    const existing = await this.prisma.notificationTemplate.findFirst({
      where: { id, protocolId: protocol.protocolId, isActive: true },
    });
    if (!existing) {
      throw new NotFoundException('Template not found');
    }

    await this.prisma.notificationTemplate.update({
      where: { id },
      data: { isActive: false },
    });

    return { success: true };
  }
}
