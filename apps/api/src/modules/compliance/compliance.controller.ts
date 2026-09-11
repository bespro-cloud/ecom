import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { complianceDecisionSchema, uuidSchema } from '@health/validation';
import type { ComplianceDecisionInput } from '@health/validation';
import type { AuthenticatedPrincipal, PublishReadiness } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { ComplianceService, type ComplianceReviewView } from './compliance.service.js';

const expiringQuerySchema = z.object({
  withinDays: z.coerce.number().int().min(0).max(365).default(30),
});

/**
 * Compliance review.
 *
 * `COMPLIANCE_APPROVE` is held only by COMPLIANCE_REVIEWER and SUPER_ADMIN —
 * ADMIN deliberately does not have it. Recording a decision additionally
 * requires MFA, because it is the control that decides what health information
 * reaches customers.
 */
@ApiTags('Compliance')
@Controller({ path: 'compliance', version: '1' })
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('products/:id')
  @RequirePermissions('COMPLIANCE_READ')
  @ApiOperation({
    summary: 'The review packet for a product',
    description: 'The listing, the current checklist evaluation and the full decision history.',
  })
  async packet(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.compliance.reviewPacket(id);
  }

  @Get('products/:id/history')
  @RequirePermissions('COMPLIANCE_READ')
  @ApiOperation({
    summary: 'Decision history',
    description: 'Append-only — the database rejects updates and deletes on these records.',
  })
  async history(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
  ): Promise<{ data: ComplianceReviewView[] }> {
    return { data: await this.compliance.history(id) };
  }

  @Post('products/:id/decision')
  @RequirePermissions('COMPLIANCE_APPROVE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Record a compliance decision',
    description:
      'Requires written reasoning. An approval satisfies one check on the publishing gate — it does not publish anything, and the gate re-evaluates everything at the moment of publication.',
  })
  async decide(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(complianceDecisionSchema)) input: ComplianceDecisionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ review: ComplianceReviewView; readiness: PublishReadiness }> {
    return this.compliance.decide(id, input, {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    });
  }

  @Get('expiring')
  @RequirePermissions('COMPLIANCE_READ')
  @ApiOperation({
    summary: 'Approvals that have lapsed or are about to',
    description:
      'So an expiry is noticed before a customer is reading a listing nobody has reviewed for a year.',
  })
  async expiring(@Query(zodBody(expiringQuerySchema)) query: z.infer<typeof expiringQuerySchema>) {
    return { data: await this.compliance.expiringApprovals(query.withinDays) };
  }
}
