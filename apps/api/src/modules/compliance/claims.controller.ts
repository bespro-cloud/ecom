import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  claimDecisionSchema,
  claimQuerySchema,
  createClaimSchema,
  createDocumentSchema,
  createEvidenceSchema,
  documentQuerySchema,
  evidenceDecisionSchema,
  evidenceQuerySchema,
  linkEvidenceSchema,
  reviseClaimSchema,
  submitClaimSchema,
  updateEvidenceSchema,
  uuidSchema,
  withdrawClaimSchema,
  type ClaimDecisionInput,
  type ClaimQuery,
  type CreateClaimInput,
  type CreateDocumentInput,
  type CreateEvidenceInput,
  type DocumentQuery,
  type EvidenceDecisionInput,
  type EvidenceQuery,
  type LinkEvidenceInput,
  type ReviseClaimInput,
  type SubmitClaimInput,
  type UpdateEvidenceInput,
  type WithdrawClaimInput,
} from '@health/validation';
import { z } from 'zod';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { ClaimsService } from './claims/claims.service.js';
import { EvidenceService } from './evidence/evidence.service.js';
import { DocumentsService } from './documents/documents.service.js';

const archiveSchema = z.object({ reason: z.string().trim().min(5).max(500) });

/**
 * Claims, evidence and documents.
 *
 * The permission split is the substance of the separation of duty this module
 * exists to enforce:
 *
 * - `CLAIM_WRITE` drafts and revises a claim. Held by product managers, who
 *   write the copy.
 * - `CLAIM_APPROVE` decides one. Held by compliance reviewers **and nobody
 *   else** — not `ADMIN`, not `PRODUCT_MANAGER`. The person who writes a health
 *   claim cannot be the person who signs it off.
 * - `EVIDENCE_WRITE` records a source; `EVIDENCE_APPROVE` judges whether it is
 *   sound. Different questions, different authority.
 *
 * Both approval routes additionally require MFA. They are the controls that
 * decide what health information reaches customers, which is the same bar that
 * puts a second factor on issuing a refund.
 */
@ApiTags('Compliance')
@Controller({ path: 'admin/compliance', version: '1' })
export class ClaimsController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly evidence: EvidenceService,
    private readonly documents: DocumentsService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  // --- claims --------------------------------------------------------------

  @Get('claims')
  @RequirePermissions('CLAIM_READ')
  @ApiOperation({ summary: 'List claims' })
  async listClaims(@Query(zodBody(claimQuerySchema)) query: ClaimQuery) {
    return this.claims.list(query);
  }

  @Get('claims/:id')
  @RequirePermissions('CLAIM_READ')
  @ApiOperation({
    summary: 'One claim with its versions, evidence and decisions',
    description:
      'Every version ever written is listed. The approved one is identified separately from the current one, because they are often not the same.',
  })
  async findClaim(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.claims.findById(id);
  }

  @Post('products/:productId/claims')
  @RequirePermissions('CLAIM_WRITE')
  @ApiOperation({
    summary: 'Record a claim against a product',
    description:
      'A claim exists because a person wrote it down. Nothing reads marketing copy and infers one.',
  })
  async createClaim(
    @Param('productId', new ZodValidationPipe(uuidSchema)) productId: string,
    @Body(zodBody(createClaimSchema)) input: CreateClaimInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.claims.create(productId, input, this.actor(principal, request));
  }

  @Post('claims/:id/versions')
  @RequirePermissions('CLAIM_WRITE')
  @ApiOperation({
    summary: 'Revise the wording',
    description:
      'Writes a new version and re-opens the claim for review. The approved version is untouched and keeps showing on the listing until the new one is approved.',
  })
  async reviseClaim(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(reviseClaimSchema)) input: ReviseClaimInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.claims.revise(id, input, this.actor(principal, request));
  }

  @Post('claims/:id/submit')
  @RequirePermissions('CLAIM_WRITE')
  @ApiOperation({
    summary: 'Send a claim for review',
    description: 'Refused if the claim type needs substantiation and none has been accepted.',
  })
  async submitClaim(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(submitClaimSchema)) input: SubmitClaimInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.claims.submit(id, input, this.actor(principal, request));
  }

  @Post('claims/:id/decision')
  @RequirePermissions('CLAIM_APPROVE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Approve or reject a claim',
    description:
      'Names the version being decided, and is refused if the wording moved underneath. Requires MFA: this decides what a customer is told about a health product.',
  })
  async decideClaim(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(claimDecisionSchema)) input: ClaimDecisionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.claims.decide(id, input, this.actor(principal, request));
  }

  @Post('claims/:id/withdraw')
  @RequirePermissions('CLAIM_WRITE')
  @ApiOperation({ summary: 'Take a claim off the listing' })
  async withdrawClaim(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(withdrawClaimSchema)) input: WithdrawClaimInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.claims.withdraw(id, input, this.actor(principal, request));
  }

  // --- evidence ------------------------------------------------------------

  @Get('evidence')
  @RequirePermissions('EVIDENCE_READ')
  @ApiOperation({ summary: 'The evidence library' })
  async listEvidence(@Query(zodBody(evidenceQuerySchema)) query: EvidenceQuery) {
    return this.evidence.list(query);
  }

  @Get('evidence/:id')
  @RequirePermissions('EVIDENCE_READ')
  @ApiOperation({ summary: 'One source, and the claims it is attached to' })
  async findEvidence(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.evidence.findById(id);
  }

  @Post('evidence')
  @RequirePermissions('EVIDENCE_WRITE')
  @ApiOperation({
    summary: 'Record a source',
    description:
      'Every field is entered by the person who read it. Nothing is fetched from an identifier or summarised.',
  })
  async createEvidence(
    @Body(zodBody(createEvidenceSchema)) input: CreateEvidenceInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.evidence.create(input, this.actor(principal, request));
  }

  @Patch('evidence/:id')
  @RequirePermissions('EVIDENCE_WRITE')
  @ApiOperation({
    summary: 'Correct a source',
    description: 'Refused once reviewed, because approvals rest on what it said.',
  })
  async updateEvidence(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateEvidenceSchema)) input: UpdateEvidenceInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.evidence.update(id, input, this.actor(principal, request));
  }

  @Post('evidence/:id/decision')
  @RequirePermissions('EVIDENCE_APPROVE')
  @RequireMfa()
  @ApiOperation({ summary: 'Accept or reject a source' })
  async decideEvidence(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(evidenceDecisionSchema)) input: EvidenceDecisionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.evidence.decide(id, input, this.actor(principal, request));
  }

  @Post('claims/:id/evidence')
  @RequirePermissions('EVIDENCE_WRITE')
  @ApiOperation({ summary: 'Attach a source to a claim' })
  async linkEvidence(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(linkEvidenceSchema)) input: LinkEvidenceInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.evidence.link(id, input, this.actor(principal, request));
    return { ok: true };
  }

  @Delete('claims/:id/evidence/:evidenceId')
  @RequirePermissions('EVIDENCE_WRITE')
  @ApiOperation({
    summary: 'Detach a source from a claim',
    description: 'Refused while the claim is approved: the approval rests on what was attached.',
  })
  async unlinkEvidence(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Param('evidenceId', new ZodValidationPipe(uuidSchema)) evidenceId: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.evidence.unlink(id, evidenceId, this.actor(principal, request));
    return { ok: true };
  }

  // --- documents -----------------------------------------------------------

  @Get('documents')
  @RequirePermissions('DOCUMENT_READ')
  @ApiOperation({
    summary: 'Regulatory and quality documents',
    description:
      'Every document is reported as stated by its uploader and never as verified by this system.',
  })
  async listDocuments(@Query(zodBody(documentQuerySchema)) query: DocumentQuery) {
    return this.documents.list(query);
  }

  @Post('documents')
  @RequirePermissions('DOCUMENT_WRITE')
  @ApiOperation({ summary: 'Record a document against a product or a lot' })
  async createDocument(
    @Body(zodBody(createDocumentSchema)) input: CreateDocumentInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.documents.create(input, this.actor(principal, request));
  }

  @Post('documents/:id/archive')
  @RequirePermissions('DOCUMENT_WRITE')
  @ApiOperation({ summary: 'Archive a document', description: 'Kept, never deleted.' })
  async archiveDocument(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(archiveSchema)) input: { reason: string },
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.documents.archive(id, input.reason, this.actor(principal, request));
    return { ok: true };
  }
}
