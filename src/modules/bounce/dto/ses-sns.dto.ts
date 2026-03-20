import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsArray } from 'class-validator';

export class SesBouncedRecipientDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    emailAddress?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    diagnosticCode?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    status?: string;
}

export class SesBounceDetailsDto {
    @ApiProperty()
    @IsString()
    bounceType: string;

    @ApiProperty()
    @IsArray()
    bouncedRecipients: SesBouncedRecipientDto[];
}

export class SesMailDto {
    @ApiProperty()
    @IsString()
    messageId: string;
}

export class SesMessageDto {
    @ApiProperty()
    @IsString()
    notificationType: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsObject()
    mail?: SesMailDto;

    @ApiPropertyOptional()
    @IsOptional()
    @IsObject()
    bounce?: SesBounceDetailsDto;
}

export class SesSnsPayloadDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    Type?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    notificationType?: string;

    @ApiPropertyOptional()
    @IsOptional()
    Message?: string | SesMessageDto | Record<string, unknown>;

    @ApiPropertyOptional()
    @IsOptional()
    @IsObject()
    mail?: SesMailDto;

    @ApiPropertyOptional()
    @IsOptional()
    @IsObject()
    bounce?: SesBounceDetailsDto;
}
