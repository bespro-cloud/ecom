import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { addSeconds, type Clock } from '@health/config';
import { priceOrder, type PricingLineInput } from '@health/types';
import type { AddCartItemInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import { SettingsService } from '../../settings/settings.service.js';
import { InventoryService } from '../inventory/inventory.service.js';
import type { ActorContext } from '../../rbac/roles.service.js';

export interface CartLineView {
  id: string;
  variantId: string;
  productId: string;
  slug: string;
  sku: string;
  productName: string;
  variantName: string;
  quantity: number;
  unitPriceCents: number;
  lineSubtotalCents: number;
  currency: string;
  imageUrl: string | null;
  /** Null when stock is untracked. */
  availableQuantity: number | null;
  /** True when the catalogue price has moved since the item went in. */
  priceChanged: boolean;
  quotedUnitPriceCents: number;
}

export interface CartView {
  id: string;
  currency: string;
  lines: CartLineView[];
  itemCount: number;
  subtotalCents: number;
  note: string | null;
  /** Lines whose product is no longer purchasable, with the reason. */
  unavailable: Array<{ variantId: string; sku: string; name: string; reason: string }>;
  updatedAt: string;
}

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/**
 * The shopping cart.
 *
 * **A cart is a wish, not a contract.** Nothing in it is authoritative: prices
 * are re-read from the catalogue on every view, and the totals stored on the
 * row are a cache for rendering, never what a customer is charged. Checkout
 * reprices from scratch. That is what makes a stale cart harmless.
 *
 * **Guest carts are bearer-token addressed.** The token lives in an httpOnly
 * cookie and is the only way to reach the cart; there is no route that takes a
 * cart id. A guessable id in a URL would be a way to read someone else's
 * basket.
 *
 * **Merging on sign-in adds, it does not replace.** Someone who filled a
 * basket while signed out and then signs in keeps both baskets. Quietly
 * discarding either is the kind of data loss a customer notices and cannot
 * undo.
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(CartService.name);
  }

  private async cartLifetimeSeconds(): Promise<number> {
    const days = (await this.settings.get<number>('cart.lifetime_days')) ?? 30;
    return days * 24 * 60 * 60;
  }

  /**
   * Finds or creates the cart for this caller.
   *
   * A signed-in customer always gets their own cart; a guest gets the one their
   * token names, or a new one.
   */
  async resolve(owner: {
    customerId?: string | null;
    token?: string | null;
  }): Promise<{ cart: { id: string; token: string | null }; issuedToken: string | null }> {
    if (owner.customerId) {
      const existing = await this.prisma.cart.findFirst({
        where: { customerId: owner.customerId, status: 'ACTIVE' },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, token: true },
      });
      if (existing) return { cart: existing, issuedToken: null };

      const created = await this.prisma.cart.create({
        data: {
          customerId: owner.customerId,
          expiresAt: addSeconds(this.clock.now(), await this.cartLifetimeSeconds()),
        },
        select: { id: true, token: true },
      });
      return { cart: created, issuedToken: null };
    }

    if (owner.token) {
      const existing = await this.prisma.cart.findFirst({
        where: { token: owner.token, status: 'ACTIVE' },
        select: { id: true, token: true },
      });
      if (existing) return { cart: existing, issuedToken: null };
    }

    // 32 bytes from the CSPRNG. The token is the only thing protecting the
    // cart, so it is sized like a session token rather than like an id.
    const token = randomBytes(32).toString('base64url');
    const created = await this.prisma.cart.create({
      data: {
        token,
        expiresAt: addSeconds(this.clock.now(), await this.cartLifetimeSeconds()),
      },
      select: { id: true, token: true },
    });
    return { cart: created, issuedToken: token };
  }

  /**
   * The cart, priced against the catalogue as it stands now.
   *
   * Anything that has become unpurchasable — withdrawn, deleted, or a variant
   * deactivated — is reported separately rather than silently dropped. A basket
   * that quietly loses an item is worse than one that explains itself.
   */
  async view(cartId: string): Promise<CartView> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: {
            variant: {
              include: {
                product: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                    status: true,
                    deletedAt: true,
                    priceCents: true,
                    currency: true,
                    images: {
                      where: { role: 'HERO' },
                      take: 1,
                      select: { media: { select: { id: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!cart) throw AppException.notFound('Cart');

    const variantIds = cart.items.map((item) => item.variantId);
    const availability = await this.inventory.availability(variantIds);

    const lines: CartLineView[] = [];
    const unavailable: CartView['unavailable'] = [];

    for (const item of cart.items) {
      const variant = item.variant;
      const product = variant.product;

      // Published, not deleted, variant active. Anything else cannot be sold,
      // and the customer is told which and why.
      const reason =
        product.deletedAt !== null
          ? 'This product is no longer sold.'
          : product.status !== 'PUBLISHED'
            ? 'This product is not currently available.'
            : variant.deletedAt !== null || !variant.isActive
              ? 'This option is no longer available.'
              : null;

      if (reason) {
        unavailable.push({
          variantId: variant.id,
          sku: variant.sku,
          name: `${product.name} — ${variant.name}`,
          reason,
        });
        continue;
      }

      // The variant price when set, otherwise the product's. Read now, never
      // taken from the cart row.
      const unitPriceCents = variant.priceCents ?? product.priceCents;

      lines.push({
        id: item.id,
        variantId: variant.id,
        productId: product.id,
        slug: product.slug,
        sku: variant.sku,
        productName: product.name,
        variantName: variant.name,
        quantity: item.quantity,
        unitPriceCents,
        lineSubtotalCents: unitPriceCents * item.quantity,
        currency: product.currency,
        imageUrl: null,
        availableQuantity: availability.get(variant.id) ?? null,
        priceChanged: unitPriceCents !== item.quotedUnitPriceCents,
        quotedUnitPriceCents: item.quotedUnitPriceCents,
      });
    }

    const subtotalCents = lines.reduce((sum, line) => sum + line.lineSubtotalCents, 0);

    return {
      id: cart.id,
      currency: cart.currency,
      lines,
      itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
      subtotalCents,
      note: cart.note,
      unavailable,
      updatedAt: cart.updatedAt.toISOString(),
    };
  }

  /**
   * Adds an item, or increases an existing line.
   *
   * Only a published product with an active variant can be added. The check is
   * here rather than only in the UI because the endpoint is public and a
   * request can name any variant id.
   */
  async addItem(cartId: string, input: AddCartItemInput): Promise<CartView> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: input.variantId, deletedAt: null, isActive: true },
      include: {
        product: { select: { id: true, status: true, deletedAt: true, priceCents: true } },
      },
    });

    if (!variant || variant.product.deletedAt !== null || variant.product.status !== 'PUBLISHED') {
      // Deliberately the same answer for "does not exist" and "not for sale":
      // the endpoint is public, and distinguishing them would let anyone
      // enumerate unpublished products.
      throw AppException.notFound('Product');
    }

    const unitPriceCents = variant.priceCents ?? variant.product.priceCents;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.cartItem.findUnique({
        where: { cartId_variantId: { cartId, variantId: input.variantId } },
        select: { id: true, quantity: true },
      });

      if (existing) {
        const quantity = Math.min(999, existing.quantity + input.quantity);
        await tx.cartItem.update({
          where: { id: existing.id },
          data: { quantity, quotedUnitPriceCents: unitPriceCents, quotedAt: this.clock.now() },
        });
      } else {
        await tx.cartItem.create({
          data: {
            cartId,
            variantId: input.variantId,
            quantity: input.quantity,
            quotedUnitPriceCents: unitPriceCents,
          },
        });
      }

      await this.touch(tx, cartId);
    });

    return this.view(cartId);
  }

  /** Sets a line's quantity. Zero removes it. */
  async setItemQuantity(cartId: string, itemId: string, quantity: number): Promise<CartView> {
    const item = await this.prisma.cartItem.findFirst({
      where: { id: itemId, cartId },
      select: { id: true },
    });
    if (!item) throw AppException.notFound('Cart item');

    await this.prisma.$transaction(async (tx) => {
      if (quantity === 0) {
        await tx.cartItem.delete({ where: { id: itemId } });
      } else {
        await tx.cartItem.update({ where: { id: itemId }, data: { quantity } });
      }
      await this.touch(tx, cartId);
    });

    return this.view(cartId);
  }

  async removeItem(cartId: string, itemId: string): Promise<CartView> {
    return this.setItemQuantity(cartId, itemId, 0);
  }

  async setNote(cartId: string, note: string | null): Promise<CartView> {
    await this.prisma.cart.update({ where: { id: cartId }, data: { note } });
    return this.view(cartId);
  }

  async clear(cartId: string): Promise<CartView> {
    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { cartId } });
      await this.touch(tx, cartId);
    });
    // Holding stock for an empty cart helps nobody.
    await this.inventory.release({ cartId });
    return this.view(cartId);
  }

  /**
   * Merges a guest cart into a customer's on sign-in.
   *
   * Quantities are **added**, not replaced: someone who put two of something in
   * while signed out and already had one signed in wants three, and in any case
   * losing either basket silently is not a decision this code should make on
   * their behalf. The guest cart is then marked converted so the token stops
   * resolving.
   */
  async mergeGuestCart(
    guestToken: string,
    customerId: string,
    actor: ActorContext,
  ): Promise<{ cartId: string; merged: number }> {
    const guest = await this.prisma.cart.findFirst({
      where: { token: guestToken, status: 'ACTIVE' },
      include: { items: true },
    });
    if (!guest) {
      const { cart } = await this.resolve({ customerId });
      return { cartId: cart.id, merged: 0 };
    }

    // A guest cart that already belongs to this customer needs no merge.
    if (guest.customerId === customerId) {
      return { cartId: guest.id, merged: 0 };
    }

    const { cart: target } = await this.resolve({ customerId });

    if (guest.id === target.id) {
      return { cartId: target.id, merged: 0 };
    }

    let merged = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const item of guest.items) {
        const existing = await tx.cartItem.findUnique({
          where: { cartId_variantId: { cartId: target.id, variantId: item.variantId } },
          select: { id: true, quantity: true },
        });

        if (existing) {
          await tx.cartItem.update({
            where: { id: existing.id },
            data: { quantity: Math.min(999, existing.quantity + item.quantity) },
          });
        } else {
          await tx.cartItem.create({
            data: {
              cartId: target.id,
              variantId: item.variantId,
              quantity: item.quantity,
              quotedUnitPriceCents: item.quotedUnitPriceCents,
            },
          });
        }
        merged += 1;
      }

      await tx.cart.update({
        where: { id: guest.id },
        // Status only. A merged cart stops resolving because `resolve` filters
        // on ACTIVE; nulling the token as well would break the ownership check
        // on any checkout that cart had already started.
        data: { status: 'CONVERTED', convertedAt: this.clock.now() },
      });

      await this.touch(tx, target.id);

      if (merged > 0) {
        await this.audit.recordIn(tx, {
          action: COMMERCE_AUDIT_ACTIONS.CART_MERGED,
          entityType: 'cart',
          entityId: target.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: { mergedLines: merged, fromCartId: guest.id },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });
      }
    });

    // The guest cart's holds move with it.
    await this.inventory.release({ cartId: guest.id });

    return { cartId: target.id, merged };
  }

  /**
   * Prices the cart for display.
   *
   * Shares the one pricing engine with checkout so a customer never sees one
   * number in the basket and another at payment.
   */
  async priceForDisplay(
    cartId: string,
    options: { shippingCents?: number; taxRate?: number | null } = {},
  ): Promise<ReturnType<typeof priceOrder> | null> {
    const view = await this.view(cartId);
    if (view.lines.length === 0) return null;

    const lines: PricingLineInput[] = view.lines.map((line) => ({
      variantId: line.variantId,
      productId: line.productId,
      sku: line.sku,
      productName: line.productName,
      variantName: line.variantName,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      taxable: true,
    }));

    return priceOrder({
      currency: 'USD',
      lines,
      shippingCents: options.shippingCents ?? 0,
      taxRate: options.taxRate ?? null,
    });
  }

  private async touch(tx: Tx, cartId: string): Promise<void> {
    await tx.cart.update({
      where: { id: cartId },
      data: { expiresAt: addSeconds(this.clock.now(), await this.cartLifetimeSeconds()) },
    });
  }
}
