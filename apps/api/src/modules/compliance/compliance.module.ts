import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service.js';
import { ComplianceController } from './compliance.controller.js';
import { CatalogueModule } from '../catalogue/catalogue.module.js';

@Module({
  imports: [CatalogueModule],
  controllers: [ComplianceController],
  providers: [ComplianceService],
  exports: [ComplianceService],
})
export class ComplianceModule {}
