import { Global, Module } from '@nestjs/common';
import { AuditService } from './audit.service.js';
import { AuditReadService } from './audit-read.service.js';
import { AuditController } from './audit.controller.js';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditReadService],
  exports: [AuditService],
})
export class AuditModule {}
