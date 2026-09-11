import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  addCartItemSchema,
  cartNoteSchema,
  updateCartItemSchema,
  uuidSchema,
  type AddCartItemInput,
  type CartNoteInput,
  type UpdateCartItemInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { Public } from '../../../common/decorators/public.decorator.js';
import { OptionalUser } from '../../../common/decorators/current-user.decorator.js';
import { zodBody, ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { AppConfigService } from '../../../infrastructure/config/app-config.service.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CartService, type CartView } from './cart.service.js';
import { readCartToken, setCartCookie } from './cart.cookie.js';

/**
 * The cart.
 *
 * Public, because shopping does not require an account. A signed-in customer's
 * cart is keyed to their customer record; a guest's is keyed to the opaque
 * token in their cookie. No route accepts a cart id, which is what stops one
 * customer reading another's basket by guessing.
 */
@ApiTags('Cart')
@Controller({ path: 'cart', version: '1' })
export class CartController {
  constructor(
    private readonly carts: CartService,
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'The current basket' })
  async view(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CartView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.carts.view(cartId);
  }

  @Post('items')
  @Public()
  @ApiOperation({
    summary: 'Add an item',
    description:
      'Only a published product with an active variant can be added. The check is server-side because the endpoint is public.',
  })
  async addItem(
    @Body(zodBody(addCartItemSchema)) input: AddCartItemInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CartView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.carts.addItem(cartId, input);
  }

  @Patch('items/:itemId')
  @Public()
  @ApiOperation({ summary: 'Change a line quantity. Zero removes the line.' })
  async updateItem(
    @Param('itemId', new ZodValidationPipe(uuidSchema)) itemId: string,
    @Body(zodBody(updateCartItemSchema)) input: UpdateCartItemInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CartView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.carts.setItemQuantity(cartId, itemId, input.quantity);
  }

  @Delete('items/:itemId')
  @Public()
  @ApiOperation({ summary: 'Remove a line' })
  async removeItem(
    @Param('itemId', new ZodValidationPipe(uuidSchema)) itemId: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CartView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.carts.removeItem(cartId, itemId);
  }

  @Patch('note')
  @Public()
  @ApiOperation({ summary: 'Set a note for the warehouse' })
  async setNote(
    @Body(zodBody(cartNoteSchema)) input: CartNoteInput,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CartView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.carts.setNote(cartId, input.note);
  }

  @Delete()
  @Public()
  @ApiOperation({ summary: 'Empty the basket' })
  async clear(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @OptionalUser() principal?: AuthenticatedPrincipal,
  ): Promise<CartView> {
    const cartId = await this.resolveCartId(request, response, principal);
    return this.carts.clear(cartId);
  }

  /**
   * Resolves the caller's cart, issuing a guest token when there is none.
   *
   * A signed-in customer never uses the guest token, even if the cookie is
   * still present: their own cart is authoritative. The merge that reconciles
   * the two happens once, at sign-in.
   */
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

  private async customerIdFor(userId: string): Promise<string | null> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    return customer?.id ?? null;
  }
}
