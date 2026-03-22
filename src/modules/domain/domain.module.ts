import { Module } from '@nestjs/common';
import { DomainController } from './domain.controller';
import { DkimService } from './dkim.service';

@Module({
    controllers: [DomainController],
    providers: [DkimService],
    exports: [DkimService],
})
export class DomainModule { }
