import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  adjustInventorySchema,
  cancelOrderSchema,
  createShippingRateSchema,
  createWarehouseSchema,
  inventoryQuerySchema,
  issueRefundSchema,
  orderNoteSchema,
  orderQuerySchema,
  upsertInventorySchema,
  uuidSchema,
  type AdjustInventoryInput,
  type CancelOrderInput,
  type CreateShippingRateInput,
  type CreateWarehouseInput,
  type InventoryQuery,
  type IssueRefundInput,
  type OrderNoteInput,
  type OrderQuery,
  type UpsertInventoryInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { OrdersService } from './orders/orders.service.js';
import { RefundsService } from './refunds/refunds.service.js';
import { InventoryService } from './inventory/inventory.service.js';
import { WarehousesService } from './inventory/warehouses.service.js';
import { ShippingService } from './shipping/shipping.service.js';
import { PaymentsService } from './payments/payments.service.js';

/**
 * Commerce administration.
 *
 * The permission split reflects who is trusted with what: `ORDER_READ` to look,
 * `ORDER_CANCEL` to stop an order, `REFUND_ISSUE` to give money back, and
 * `INVENTORY_ADJUST` to change stock. Reading an order and refunding one are
 * deliberately different authorities.
 */
@ApiTags('Commerce administration')
@Controller({ path: 'admin/commerce', version: '1' })
export class CommerceAdminController {
  constructor(
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly inventory: InventoryService,
    private readonly warehouses: WarehousesService,
    private readonly shipping: ShippingService,
    private readonly payments: PaymentsService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  // --- orders --------------------------------------------------------------

  @Get('orders')
  @RequirePermissions('ORDER_READ')
  @ApiOperation({ summary: 'List orders' })
  async listOrders(@Query(zodBody(orderQuerySchema)) query: OrderQuery) {
    return this.orders.list(query);
  }

  @Get('orders/:id')
  @RequirePermissions('ORDER_READ')
  @ApiOperation({
    summary: 'One order, with its timeline',
    description: 'The timeline is append-only and is the record of what happened to this order.',
  })
  async findOrder(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    const order = await this.orders.findById(id);
    return { ...order, paymentIsRealMoney: this.payments.isRealMoney };
  }

  @Post('orders/:id/cancel')
  @RequirePermissions('ORDER_CANCEL')
  @ApiOperation({
    summary: 'Cancel an order',
    description: 'Releases reserved stock. Refunding is a separate, deliberate step.',
  })
  async cancelOrder(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(cancelOrderSchema)) input: CancelOrderInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.orders.cancel(id, input, this.actor(principal, request));
  }

  @Post('orders/:id/notes')
  @RequirePermissions('ORDER_WRITE')
  @ApiOperation({ summary: 'Add a note to the order timeline' })
  async addNote(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(orderNoteSchema)) input: OrderNoteInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.orders.addNote(id, input.note, input.isInternal, this.actor(principal, request));
    return { ok: true };
  }

  // --- refunds -------------------------------------------------------------

  @Post('orders/:id/refunds')
  @RequirePermissions('REFUND_ISSUE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Issue a refund',
    description:
      'Idempotent, capped at what remains captured, and recorded with a reason against a named person. Requires MFA: this moves money out.',
  })
  async issueRefund(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(issueRefundSchema)) input: IssueRefundInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.refunds.issue(id, input, this.actor(principal, request));
  }

  @Get('orders/:id/refunds')
  @RequirePermissions('REFUND_READ')
  @ApiOperation({ summary: 'Refunds against an order' })
  async listRefunds(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return { data: await this.refunds.listForOrder(id) };
  }

  // --- inventory -----------------------------------------------------------

  @Get('inventory')
  @RequirePermissions('INVENTORY_READ')
  @ApiOperation({ summary: 'Stock levels' })
  async listStock(@Query(zodBody(inventoryQuerySchema)) query: InventoryQuery) {
    return this.warehouses.listStock(query);
  }

  @Post('inventory')
  @RequirePermissions('INVENTORY_ADJUST')
  @ApiOperation({
    summary: 'Configure stock tracking for a variant',
    description:
      'Sets policy only. Quantities move through an adjustment, which carries a reason and lands in the append-only ledger.',
  })
  async configureInventory(
    @Body(zodBody(upsertInventorySchema)) input: UpsertInventoryInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.warehouses.configure(input, this.actor(principal, request));
  }

  @Post('inventory/adjustments')
  @RequirePermissions('INVENTORY_ADJUST')
  @ApiOperation({
    summary: 'Record a stock adjustment',
    description:
      'Signed delta with a required reason. Refused if it would take stock negative or below what is reserved for open orders.',
  })
  async adjustInventory(
    @Body(zodBody(adjustInventorySchema)) input: AdjustInventoryInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.inventory.adjust(input, this.actor(principal, request));
  }

  @Get('inventory/:id/adjustments')
  @RequirePermissions('INVENTORY_READ')
  @ApiOperation({ summary: 'The adjustment ledger for one stock record' })
  async listAdjustments(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return { data: await this.warehouses.listAdjustments(id) };
  }

  // --- warehouses ----------------------------------------------------------

  @Get('warehouses')
  @RequirePermissions('INVENTORY_READ')
  @ApiOperation({ summary: 'List warehouses' })
  async listWarehouses(
    @Query(zodBody(z.object({ includeInactive: z.coerce.boolean().optional() })))
    query: {
      includeInactive?: boolean;
    },
  ) {
    return { data: await this.warehouses.list(query.includeInactive ?? false) };
  }

  @Post('warehouses')
  @RequirePermissions('INVENTORY_ADJUST')
  @ApiOperation({ summary: 'Create a warehouse' })
  async createWarehouse(
    @Body(zodBody(createWarehouseSchema)) input: CreateWarehouseInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.warehouses.create(input, this.actor(principal, request));
  }

  // --- shipping ------------------------------------------------------------

  @Get('shipping-rates')
  @RequirePermissions('ORDER_READ')
  @ApiOperation({ summary: 'List shipping rates' })
  async listRates() {
    return { data: await this.shipping.list(true) };
  }

  @Post('shipping-rates')
  @RequirePermissions('SYSTEM_SETTINGS')
  @ApiOperation({
    summary: 'Create a shipping rate',
    description: 'What delivery costs is configuration; changing it does not need a deploy.',
  })
  async createRate(
    @Body(zodBody(createShippingRateSchema)) input: CreateShippingRateInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.shipping.create(input, this.actor(principal, request));
  }
}
