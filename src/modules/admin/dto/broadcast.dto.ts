import { IsString, IsNotEmpty, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class BroadcastDto {
  @ApiProperty({
    example: 'Platform Update: New Features',
    description: 'The subject of the system message',
  })
  @IsString()
  @IsNotEmpty()
  subject: string;

  @ApiProperty({
    example: 'We have just launched... check it out!',
    description: 'The HTML or plain text body of the message',
  })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiProperty({
    example: 'marketing',
    description: 'Notification category (System is marketing per requirements)',
    enum: ['marketing', 'defi', 'governance', 'system'],
  })
  @IsEnum(['marketing', 'defi', 'governance', 'system'])
  category: string = 'marketing';
}
