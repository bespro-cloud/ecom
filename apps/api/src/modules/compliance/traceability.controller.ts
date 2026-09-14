import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  approveRecallNotificationSchema,
  batchDispositionSchema,
  batchQuerySchema,
  cancelRecallSchema,
  closeRecallSchema,
  createRecallSchema,
  lotTrackingSchema,
  receiveBatchSchema,
  recallLotsSchema,
  recallNoteSchema,
  recallQuerySchema,
  recallRegulatorSchema,
  uuidSchema,
  type ApproveRecallNotificationInput,
  type BatchDispositionInput,
  type BatchQuery,
  type CancelRecallInput,
  type CloseRecallInput,
  type CreateRecallInput,
  type LotTrackingInput,
  type ReceiveBatchInput,
  type RecallLotsInput,
  type RecallNoteInput,
  type RecallQuery,
  type RecallRegulatorInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { BatchesService } from './batches/batches.service.js';
import { RecallsService } from './recalls/recalls.service.js';

/**
 * Lots and recalls.
 *
 * The permission split here separates operational acts from legally
 * consequential ones:
 *
 * - `BATCH_WRITE` receives stock. Warehouse work.
 * - `BATCH_QUARANTINE` holds or releases a lot. A quality decision, so the
 *   warehouse manager and the compliance reviewer both hold it.
 * - `RECALL_MANAGE` opens, progresses and closes a recall — including
 *   withdrawing stock from sale, which happens immediately and deliberately
 *   needs no second approval: stock that may be unsafe should stop being sold
 *   the moment somebody with the authority says so.
 * - `RECALL_NOTIFY` approves contacting customers, requires MFA, and is held
 *   only by the compliance reviewer. Withdrawing stock and telling people they
 *   consumed it are not the same decision and are not the same authority.
 *
 * Nothing on this controller sends a message to a customer. The approval route
 * unlocks the affected-customer list and records who unlocked it; acting on it
 * is a manual step outside this system.
 */
@ApiTags('Traceability')
@Controller({ path: 'admin/traceability', version: '1' })
export class TraceabilityController {
  constructor(
    private readonly batches: BatchesService,
    private readonly recalls: RecallsService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  // --- lots ----------------------------------------------------------------

  @Get('batches')
  @RequirePermissions('BATCH_READ')
  @ApiOperation({ summary: 'Lots, earliest expiry first' })
  async listBatches(@Query(zodBody(batchQuerySchema)) query: BatchQuery) {
    return this.batches.list(query);
  }

  @Get('batches/:id')
  @RequirePermissions('BATCH_READ')
  @ApiOperation({ summary: 'One lot, with its full disposition history' })
  async findBatch(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.batches.findById(id);
  }

  @Post('batches')
  @RequirePermissions('BATCH_WRITE')
  @ApiOperation({
    summary: 'Receive a lot',
    description:
      'Creates the stock record if needed and turns on lot tracking for it, so allocation becomes first-expiry-first-out.',
  })
  async receiveBatch(
    @Body(zodBody(receiveBatchSchema)) input: ReceiveBatchInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.batches.receive(input, this.actor(principal, request));
  }

  @Post('batches/:id/disposition')
  @RequirePermissions('BATCH_QUARANTINE')
  @ApiOperation({
    summary: 'Quarantine, release or dispose of a lot',
    description:
      'A written reason is required in both directions and cannot be edited afterwards. Units already reserved against open orders are left alone: cancelling a paid order is a decision for a person.',
  })
  async setDisposition(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(batchDispositionSchema)) input: BatchDispositionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.batches.setDisposition(id, input, this.actor(principal, request));
  }

  @Post('lot-tracking')
  @RequirePermissions('BATCH_WRITE')
  @ApiOperation({ summary: 'Turn lot tracking on or off for a stock record' })
  async setLotTracking(
    @Body(zodBody(lotTrackingSchema)) input: LotTrackingInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.batches.setLotTracking(input, this.actor(principal, request));
  }

  // --- recalls -------------------------------------------------------------

  @Get('recalls')
  @RequirePermissions('RECALL_READ')
  @ApiOperation({ summary: 'List recalls' })
  async listRecalls(@Query(zodBody(recallQuerySchema)) query: RecallQuery) {
    return this.recalls.list(query);
  }

  @Get('recalls/:id')
  @RequirePermissions('RECALL_READ')
  @ApiOperation({ summary: 'One recall, its lots and its full action log' })
  async findRecall(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.recalls.findById(id);
  }

  @Get('recalls/:id/impact')
  @RequirePermissions('RECALL_READ')
  @ApiOperation({
    summary: 'Who received goods from the recalled lots',
    description:
      'Counts only, until a named person with RECALL_NOTIFY has approved contacting customers. Reading this is itself recorded on the recall.',
  })
  async assessImpact(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.assessImpact(id, this.actor(principal, request));
  }

  @Post('recalls')
  @RequirePermissions('RECALL_MANAGE')
  @ApiOperation({ summary: 'Draft a recall' })
  async createRecall(
    @Body(zodBody(createRecallSchema)) input: CreateRecallInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.create(input, this.actor(principal, request));
  }

  @Post('recalls/:id/lots')
  @RequirePermissions('RECALL_MANAGE')
  @ApiOperation({ summary: 'Add lots to a recall' })
  async addLots(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(recallLotsSchema)) input: RecallLotsInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.addLots(id, input, this.actor(principal, request));
  }

  @Post('recalls/:id/open')
  @RequirePermissions('RECALL_MANAGE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Open a recall',
    description:
      'Every lot in scope stops being allocatable immediately. No customer is contacted; that needs a separate approval.',
  })
  async openRecall(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.open(id, this.actor(principal, request));
  }

  @Post('recalls/:id/approve-notification')
  @RequirePermissions('RECALL_NOTIFY')
  @RequireMfa()
  @ApiOperation({
    summary: 'Approve contacting affected customers',
    description:
      'Its own permission and a second factor, because this is the decision with legal consequences for people outside the business. Approving still sends nothing: it unlocks the affected-customer list and records who approved it and why.',
  })
  async approveNotification(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(approveRecallNotificationSchema)) input: ApproveRecallNotificationInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.approveNotification(id, input, this.actor(principal, request));
  }

  @Post('recalls/:id/regulator')
  @RequirePermissions('RECALL_MANAGE')
  @ApiOperation({ summary: 'Record that a regulator was notified' })
  async recordRegulator(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(recallRegulatorSchema)) input: RecallRegulatorInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.recordRegulatorNotification(id, input, this.actor(principal, request));
  }

  @Post('recalls/:id/notes')
  @RequirePermissions('RECALL_MANAGE')
  @ApiOperation({ summary: 'Add a note to the recall log' })
  async addNote(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(recallNoteSchema)) input: RecallNoteInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.addNote(id, input, this.actor(principal, request));
  }

  @Post('recalls/:id/close')
  @RequirePermissions('RECALL_MANAGE')
  @ApiOperation({
    summary: 'Close a recall',
    description: 'Recalled stock stays recalled. Closing records that the response is finished.',
  })
  async closeRecall(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(closeRecallSchema)) input: CloseRecallInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.close(id, input, this.actor(principal, request));
  }

  @Post('recalls/:id/cancel')
  @RequirePermissions('RECALL_MANAGE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Cancel a recall opened in error',
    description:
      'Restores each lot to the status it held before, not to available. Unavailable once customer contact has been approved.',
  })
  async cancelRecall(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(cancelRecallSchema)) input: CancelRecallInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.recalls.cancel(id, input, this.actor(principal, request));
  }
}
