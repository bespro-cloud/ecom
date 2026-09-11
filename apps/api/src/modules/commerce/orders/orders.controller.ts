import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { uuidSchema } from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser, OptionalUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { readCartToken } from '../cart/cart.cookie.js';
import { OrdersService } from './orders.service.js';

/**
 * A customer's own orders.
 *
 * An order id in the path is never sufficient. A signed-in customer's queries
 * are filtered by their customer id, so an id belonging to someone else simply
 * does not exist as far as this controller is concerned.
 *
 * A guest who has just checked out has no customer record, and would otherwise
 * be unable to see what they had just bought. They are matched instead against
 * the cart cookie that produced the order — an httpOnly credential they already
 * hold, rather than a new token in a URL. A token in a URL ends up in access
 * logs, browser history and `Referer` headers, which is the last place a
 * bearer credential for someone's order should be.
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
  @Public()
  @ApiOperation({
    summary: 'One of your orders',
    description:
      'Yours by customer record when signed in, or by the cart cookie that produced it when not.',
  })
  async findOne(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ) {
    const customerId = principal ? await this.requireCustomerId(principal.userId) : null;
    const cartToken = readCartToken(request);

    // Either a customer record that owns it, or the cart cookie the order came
    // from. Never both optional: a request carrying neither matches nothing,
    // because `customerId: null` would otherwise match every guest order and
    // an absent token would match every order with an absent cart.
    const ownership = customerId
      ? { customerId }
      : cartToken
        ? { checkout: { cart: { token: cartToken } } }
        : null;

    if (!ownership) throw AppException.notFound('Order');

    const order = await this.prisma.order.findFirst({
      where: { id, ...ownership },
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
