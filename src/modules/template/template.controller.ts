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
      select: {
        id: true,
        name: true,
        category: true,
        isDefault: true,
        createdAt: true,
      },
    });
    return { data: templates };
  }
}
