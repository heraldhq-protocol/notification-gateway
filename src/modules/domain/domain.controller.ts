import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, IsUrl, IsOptional } from 'class-validator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { DkimService } from './dkim.service';
import { BimiService } from './bimi.service';
import { PrismaService } from '../../database/prisma.service';

export class CreateDomainDto {
  @ApiProperty({ example: 'alerts.myprotocol.com' })
  @IsString()
  domain: string;

  @ApiProperty({ example: 'herald', required: false })
  @IsString()
  selector?: string = 'herald';
}

export class UpsertBimiDto {
  @ApiProperty({
    example:
      'https://ucshdejvxzanuxlxrano.supabase.co/storage/v1/object/public/herald-public-asset/herald-logo.svg',
  })
  @IsUrl()
  logo_url: string;

  @ApiProperty({
    example: 'https://useherald.xyz/vmc.pem',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUrl()
  vmc_url?: string;

  @ApiProperty({ example: 'default', required: false })
  @IsOptional()
  @IsString()
  selector?: string = 'default';
}

export class DkimKeyResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() domain: string;
  @ApiProperty() selector: string;
  @ApiProperty() dnsRecordName: string;
  @ApiProperty() dnsRecordValue: string;
  @ApiProperty() instructions: string;
}

@ApiTags('Domains')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/domains')
export class DomainController {
  constructor(
    private readonly dkimService: DkimService,
    private readonly bimiService: BimiService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Add a custom domain and generate DKIM configuration',
  })
  @ApiResponse({ status: 201, type: DkimKeyResponseDto })
  async create(
    @Body() dto: CreateDomainDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.dkimService.provisionDomainKey(
      protocol.protocolId,
      dto.domain,
      dto.selector,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List custom domains and DKIM keys' })
  async list(@ApiKey() protocol: AuthenticatedProtocol) {
    const keys = await this.dkimService.getDomainKeys(protocol.protocolId);
    return keys.map((k) => {
      const publicKey = k.publicKey || '';
      const base64Match = publicKey.match(
        /-----BEGIN PUBLIC KEY-----([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----/,
      );
      const base64Key = base64Match
        ? base64Match[1].replace(/\n/g, '')
        : publicKey.replace(
            /-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|[\n]/g,
            '',
          );
      return {
        id: k.id,
        domain: k.domain,
        selector: k.selector,
        dns_verified: k.dnsVerified,
        dnsRecordName: `${k.selector}._domainkey.${k.domain}`,
        dnsRecordValue: base64Key ? `v=DKIM1; k=rsa; p=${base64Key}` : '',
        created_at: k.createdAt,
      };
    });
  }

  @Post(':id/verify')
  @ApiOperation({ summary: 'Verify DNS TXT record is live for a domain' })
  @ApiResponse({
    status: 200,
    description:
      'Returns dns_verified=true if the DKIM TXT record resolves correctly',
  })
  async verify(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.dkimService.verifyDomain(id, protocol.protocolId);
  }

  @Post(':id/ses-register')
  @ApiOperation({
    summary: 'Register domain as SES email identity and enable DKIM signing',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns SES verification status and DKIM signing state',
  })
  async sesRegister(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    return this.dkimService.registerWithSes(id, protocol.protocolId);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a custom domain' })
  async remove(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    await this.dkimService.deleteDomainKey(id, protocol.protocolId);
  }

  // ── BIMI Endpoints ──────────────────────────────────────────

  @Get(':id/bimi/check')
  @ApiOperation({ summary: 'Check domain eligibility for BIMI (DMARC check)' })
  async checkBimi(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const domainKey = await this.prisma.dkimKey.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });
    if (!domainKey) throw new NotFoundException('Domain not found');

    return this.bimiService.checkEligibility(domainKey.domain);
  }

  @Post(':id/bimi')
  @ApiOperation({ summary: 'Configure BIMI for a domain' })
  async upsertBimi(
    @Param('id') id: string,
    @Body() dto: UpsertBimiDto,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const domainKey = await this.prisma.dkimKey.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });
    if (!domainKey) throw new NotFoundException('Domain not found');

    // 1. Validate logo format
    const validation = await this.bimiService.validateLogo(dto.logo_url);
    if (!validation.valid) {
      return {
        success: false,
        message: 'Logo validation failed',
        errors: validation.errors,
      };
    }

    // 2. Save or update BIMI record
    const bimi = await this.prisma.bimi_records.upsert({
      where: {
        protocol_id_domain: {
          protocol_id: protocol.protocolId,
          domain: domainKey.domain,
        },
      },
      update: {
        logo_url: dto.logo_url,
        vmc_url: dto.vmc_url,
        selector: dto.selector,
      },
      create: {
        protocol_id: protocol.protocolId,
        domain: domainKey.domain,
        logo_url: dto.logo_url,
        vmc_url: dto.vmc_url,
        selector: dto.selector,
      },
    });

    return {
      success: true,
      bimi_id: bimi.id,
      dns_record_name: `${bimi.selector}._bimi.${bimi.domain}`,
      dns_record_value: this.bimiService.generateDnsRecord(
        bimi.logo_url,
        bimi.vmc_url ?? undefined,
      ),
      validation_details: validation.details,
      instructions: `Add a TXT record to your DNS: ${bimi.selector}._bimi.${bimi.domain} with the generated value.`,
    };
  }

  @Get(':id/bimi')
  @ApiOperation({ summary: 'Get BIMI configuration and status' })
  async getBimi(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const domainKey = await this.prisma.dkimKey.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });
    if (!domainKey) throw new NotFoundException('Domain not found');

    const bimi = await this.prisma.bimi_records.findUnique({
      where: {
        protocol_id_domain: {
          protocol_id: protocol.protocolId,
          domain: domainKey.domain,
        },
      },
    });

    if (!bimi) return { bimi_enabled: false };

    return {
      ...bimi,
      dns_record_name: `${bimi.selector}._bimi.${bimi.domain}`,
      dns_record_value: this.bimiService.generateDnsRecord(
        bimi.logo_url,
        bimi.vmc_url ?? undefined,
      ),
    };
  }

  @Post(':id/bimi/sync')
  @ApiOperation({ summary: 'Sync BIMI status from DNS' })
  async syncBimi(
    @Param('id') id: string,
    @ApiKey() protocol: AuthenticatedProtocol,
  ) {
    const domainKey = await this.prisma.dkimKey.findFirst({
      where: { id, protocolId: protocol.protocolId },
    });
    if (!domainKey) throw new NotFoundException('Domain not found');

    return this.bimiService.syncBimiStatus(
      protocol.protocolId,
      domainKey.domain,
    );
  }
}
