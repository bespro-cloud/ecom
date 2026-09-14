import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  applyCouponSchema,
  completeCheckoutSchema,
  confirmCheckoutSchema,
  startCheckoutSchema,
  updateCheckoutSchema,
  uuidSchema,
  type ApplyCouponInput,
  type CompleteCheckoutInput,
  type ConfirmCheckoutInput,
  type StartCheckoutInput,
  type UpdateCheckoutInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { Public } from '../../../common/decorators/public.decorator.js';
import { OptionalUser } from '../../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { zodBody, ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../../common/request-context.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AppConfigService } from '../../../infrastructure/config/app-config.service.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CartService } from '../cart/cart.service.js';
import { readCartToken, setCartCookie } from '../cart/cart.cookie.js';
import { CheckoutService, type CheckoutView } from './checkout.service.js';
import { AnalyticsCollectionService } from '../../growth/analytics/collection.service.js';

/**
 * Checkout.
 *
 * Public, because guests buy things. Every route is scoped by the caller's own
 * cart or checkout — a checkout id is a UUID and knowing one is not authority
 * to pay with it, so the confirm step verifies the checkout belongs to the
 * caller's cart before doing anything.
 */
@ApiTags('Checkout')
@Controller({ path: 'checkout', version: '1' })
export class CheckoutController {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly analytics: AnalyticsCollectionService,
    private readonly carts: CartService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  @Post()
  @Public()
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Start a checkout',
    description:
      'Idempotent: the same key returns the same checkout rather than starting a second one.',
  })
  async start(
    @Body(zodBody(startCheckoutSchema)) input: StartCheckoutInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CheckoutView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.checkouts.start(cartId, input);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'The checkout, repriced' })
  async view(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CheckoutView> {
    await this.assertOwned(id, request, principal);
    return this.checkouts.view(id);
  }

  @Patch(':id')
  @Public()
  @ApiOperation({ summary: 'Set the address and delivery method' })
  async update(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateCheckoutSchema)) input: UpdateCheckoutInput,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CheckoutView> {
    await this.assertOwned(id, request, principal);
    return this.checkouts.update(id, input);
  }

  @Post(':id/coupon')
  @Public()
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Apply a discount code',
    description:
      'The code is the entire input. What it is worth is looked up and recomputed server-side on every repricing, so there is no amount a request could name and no stale figure to go out of date with the basket.',
  })
  async applyCoupon(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(applyCouponSchema)) input: ApplyCouponInput,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CheckoutView> {
    await this.assertOwned(id, request, principal);
    return this.checkouts.applyCoupon(id, input.code);
  }

  @Delete(':id/coupon')
  @Public()
  @ApiOperation({ summary: 'Remove the applied discount code' })
  async removeCoupon(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CheckoutView> {
    await this.assertOwned(id, request, principal);
    return this.checkouts.removeCoupon(id);
  }

  @Post(':id/prepare')
  @Public()
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Lock the total, hold the stock and create a payment intent',
    description:
      'Refuses if the quoted total is out of date. Stock is reserved before the payment exists, so money is never taken for goods that are not there.',
  })
  async prepare(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(confirmCheckoutSchema)) input: ConfirmCheckoutInput,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CheckoutView> {
    await this.assertOwned(id, request, principal);
    return this.checkouts.prepare(id, input, this.actor(principal, request));
  }

  @Post(':id/complete')
  @Public()
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Place the order once the provider confirms payment',
    description:
      'Idempotent. Asks the provider whether the payment settled rather than believing the caller.',
  })
  async complete(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(completeCheckoutSchema)) input: CompleteCheckoutInput,
    @Req() request: Request,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<{ orderId: string; reference: string }> {
    await this.assertOwned(id, request, principal);

    const { orderId } = await this.checkouts.complete(id, this.actor(principal, request));

    // The conversion is recorded from the server, from a real order, and the
    // session id is used here and forgotten. Nothing stores the link between
    // this order — which names a customer — and the visit that produced it.
    // It is deliberately awaited-but-swallowed inside the service: a
    // measurement failure must never fail a checkout that already took money.
    await this.analytics.recordConversion(input.analyticsSessionId ?? null);
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { id: true, reference: true },
    });

    // The cookie is deliberately left alone. Clearing it would make a repeated
    // complete call — a double-clicked button, a retried request — resolve to a
    // brand new cart and fail the ownership check, turning an idempotent
    // operation into a 404. The converted cart is no longer ACTIVE, so the next
    // time this guest adds something they get a fresh cart and a fresh token.
    return { orderId: order.id, reference: order.reference };
  }

  // -------------------------------------------------------------------------

  private actor(principal: AuthenticatedPrincipal | undefined, request: Request) {
    return {
      actorId: principal?.userId ?? null,
      actorLabel: principal?.email ?? 'guest',
      ...requestContextFrom(request),
    };
  }

  /**
   * Confirms the checkout belongs to the caller's cart.
   *
   * Without this, knowing a checkout UUID would be enough to read someone
   * else's address and totals, or to complete their order.
   */
  private async assertOwned(
    checkoutId: string,
    request: Request,
    principal?: AuthenticatedPrincipal,
  ): Promise<void> {
    const checkout = await this.prisma.checkout.findUnique({
      where: { id: checkoutId },
      select: { cartId: true, cart: { select: { token: true, customerId: true } } },
    });

    const token = readCartToken(request);
    const customerId = principal ? await this.customerIdFor(principal.userId) : null;

    // Matched against the checkout's own cart rather than against whatever
    // `resolve` would hand back, because a completed checkout's cart is
    // CONVERTED and `resolve` would create a new one — which would make every
    // repeat call look like someone else's.
    const owned = customerId
      ? checkout?.cart.customerId === customerId
      : Boolean(token) && checkout?.cart.token === token;

    if (!checkout || !owned) {
      // Deliberately "not found" rather than "forbidden": confirming that a
      // checkout exists is itself information.
      throw AppException.notFound('Checkout');
    }
  }

  private async customerIdFor(userId: string): Promise<string | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    return customer?.id ?? null;
  }

  private async resolveCartId(
    request: Request,
    response: Response,
    principal?: AuthenticatedPrincipal,
  ): Promise<string> {
    const customerId = principal ? await this.customerIdFor(principal.userId) : null;

    const { cart, issuedToken } = await this.carts.resolve({
      customerId,
      token: customerId ? null : readCartToken(request),
    });

    if (issuedToken) setCartCookie(response, this.config, issuedToken);
    return cart.id;
  }
}
