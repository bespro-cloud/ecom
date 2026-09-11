import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { uuidSchema } from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { OrdersService } from './orders.service.js';

/**
 * A customer's own orders.
 *
 * Authenticated, and scoped by the caller's customer record on every route. An
 * order id in the path is never sufficient — the query is filtered by customer
 * id, so an id belonging to someone else simply does not exist as far as this
 * controller is concerned.
 */
@ApiTags('Orders')
@Controller({ path: 'orders', version: '1' })
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Your orders' })
  async list(@CurrentUser() principal: AuthenticatedPrincipal) {
    const customerId = await this.requireCustomerId(principal.userId);
    return { data: await this.orders.listForCustomer(customerId) };
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of your orders' })
  async findOne(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    const customerId = await this.requireCustomerId(principal.userId);

    const order = await this.prisma.order.findFirst({
      where: { id, customerId },
      include: {
        items: { orderBy: { createdAt: 'asc' } },
        shipments: { orderBy: { createdAt: 'desc' } },
        refunds: {
          orderBy: { createdAt: 'desc' },
          // The customer sees that money came back and why in their own terms;
          // the internal notes and the reviewer identity are not theirs.
          select: { id: true, amountCents: true, status: true, createdAt: true },
        },
      },
    });
    if (!order) throw AppException.notFound('Order');

    return order;
  }

  private async requireCustomerId(userId: string): Promise<string> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw AppException.notFound('Customer');
    return customer.id;
  }
}
