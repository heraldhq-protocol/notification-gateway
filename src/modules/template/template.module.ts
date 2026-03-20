import { Module } from '@nestjs/common';
import { TemplateService } from './template.service.js';

@Module({
  providers: [TemplateService],
  exports: [TemplateService],
})
export class TemplateModule {}
