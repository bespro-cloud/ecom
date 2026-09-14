import { Module } from '@nestjs/common';
import { ComplianceService } from './compliance.service.js';
import { ComplianceController } from './compliance.controller.js';
import { ClaimsController } from './claims.controller.js';
import { TraceabilityController } from './traceability.controller.js';
import { ClaimsService } from './claims/claims.service.js';
import { EvidenceService } from './evidence/evidence.service.js';
import { DocumentsService } from './documents/documents.service.js';
import { BatchesService } from './batches/batches.service.js';
import { RecallsService } from './recalls/recalls.service.js';
import { CatalogueModule } from '../catalogue/catalogue.module.js';

/**
 * Compliance.
 *
 * `ClaimsService` and `DocumentsService` are exported because the catalogue
 * module's publishing gate needs them: a listing cannot be published while it
 * carries a claim nobody approved.
 */
@Module({
  imports: [CatalogueModule],
  controllers: [ComplianceController, ClaimsController, TraceabilityController],
  providers: [
    ComplianceService,
    ClaimsService,
    EvidenceService,
    DocumentsService,
    BatchesService,
    RecallsService,
  ],
  exports: [ComplianceService, ClaimsService, DocumentsService, BatchesService],
})
export class ComplianceModule {}
