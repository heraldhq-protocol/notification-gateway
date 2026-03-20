import { Module } from '@nestjs/common';
import { BounceController } from './bounce.controller.js';

@Module({
  controllers: [BounceController],
})
export class BounceModule {}
