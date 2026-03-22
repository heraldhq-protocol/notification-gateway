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
} from '@nestjs/common';
import {
    ApiTags,
    ApiOperation,
    ApiResponse,
    ApiBearerAuth,
    ApiProperty,
} from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { AuthGuard } from '../../common/guards/auth.guard';
import { ApiKey } from '../../common/decorators/api-key.decorator';
import type { AuthenticatedProtocol } from '../../common/types/protocol.types';
import { DkimService } from './dkim.service';

export class CreateDomainDto {
    @ApiProperty({ example: 'alerts.myprotocol.com' })
    @IsString()
    domain: string;

    @ApiProperty({ example: 'herald', required: false })
    @IsString()
    selector?: string = 'herald';
}

export class DkimKeyResponseDto {
    @ApiProperty() id: string;
    @ApiProperty() domain: string;
    @ApiProperty() selector: string;
    @ApiProperty() dnsRecordName: string;
    @ApiProperty() dnsRecordValue: string;
}

@ApiTags('Domains')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('v1/domains')
export class DomainController {
    constructor(private readonly dkimService: DkimService) { }

    @Post()
    @ApiOperation({ summary: 'Add a custom domain and generate DKIM configuration' })
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
        return keys.map((k) => ({
            id: k.id,
            domain: k.domain,
            selector: k.selector,
            dns_verified: k.dnsVerified,
            created_at: k.createdAt,
        }));
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
}
