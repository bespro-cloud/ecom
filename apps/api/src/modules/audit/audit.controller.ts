import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { listAuditLogsQuerySchema, type ListAuditLogsQuery } from '@health/validation';
import type { Paginated } from '@health/types';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AuditReadService, type AuditLogView } from './audit-read.service.js';

@ApiTags('Audit')
@Controller({ path: 'audit-logs', version: '1' })
export class AuditController {
  constructor(private readonly auditRead: AuditReadService) {}

  @Get()
  @RequirePermissions('AUDIT_READ')
  @ApiOperation({
    summary: 'Search the audit trail',
    description:
      'Append-only record of privileged and security-relevant actions. Results are ordered newest first and paginated by cursor.',
  })
  @ApiOkResponse({ description: 'A page of audit records.' })
  async list(
    @Query(zodBody(listAuditLogsQuerySchema)) query: ListAuditLogsQuery,
  ): Promise<Paginated<AuditLogView>> {
    return this.auditRead.list(query);
  }
}
