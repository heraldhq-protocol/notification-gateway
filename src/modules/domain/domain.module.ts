import { Module } from '@nestjs/common';
import { DomainController } from './domain.controller.js';
import { DkimService } from './dkim.service.js';

@Module({
    controllers: [DomainController],
    providers: [DkimService],
    exports: [DkimService],
})
export class DomainModule { }
