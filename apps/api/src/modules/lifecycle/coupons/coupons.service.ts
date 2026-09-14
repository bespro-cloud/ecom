import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { Prisma, isUniqueConstraintError } from '@health/database';
import {
  COUPON_REJECTION_MESSAGES,
  percentageDiscountCents,
  type CouponRejection,
  type CouponType,
} from '@health/types';
import type { CouponQuery, CreateCouponInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { LIFECYCLE_AUDIT_ACTIONS } from '../lifecycle.audit.js';

type Tx = Prisma.TransactionClient;

/** A basket line, as the pricing engine sees it. */
export interface DiscountableLine {
  productId: string;
  categoryIds: string[];
  quantity: number;
  unitPriceCents: number;
}

export interface CouponEvaluation {
  applicable: boolean;
  /** Minor units off the goods. Zero for a free-shipping coupon. */
  discountCents: number;
  /** True when the coupon zeroes delivery instead of discounting goods. */
  freeShipping: boolean;
  code: string;
  couponId: string | null;
  name: string | null;
  rejection: CouponRejection | null;
  message: string | null;
}

const NOT_APPLICABLE = (code: string, rejection: CouponRejection): CouponEvaluation => ({
  applicable: false,
  discountCents: 0,
  freeShipping: false,
  code,
  couponId: null,
  name: null,
  rejection,
  message: COUPON_REJECTION_MESSAGES[rejection],
});

/**
 * Discount codes.
 *
 * Two properties carry this service, and both are about not being talked into
 * giving money away.
 *
 * **The client supplies a code and nothing else.** Every request that touches a
 * coupon carries a string; the value, eligibility, limits and window are looked
 * up here and the discount is computed here. There is no field on any schema in
 * this codebase that lets a caller name an amount off, which is why a tampered
 * request produces the coupon's real value or a refusal — never a number of the
 * caller's choosing.
 *
 * **Usage limits are enforced by rows, not by a counter.** A `redemptionCount`
 * column read, compared and then incremented is the textbook lost-update bug:
 * two concurrent checkouts both read 99 of 100, both pass, both increment, and
 * the coupon is redeemed 101 times. Redemption instead inserts a row under a
 * lock on the coupon and counts the rows inside the same transaction, so the
 * second transaction sees the first one's row and loses. The counter column is
 * still maintained, for display only.
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(CouponsService.name);
  }

  // -------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------

  /**
   * What a code is worth against this basket, right now.
   *
   * Called on every repricing rather than once at application, so a basket that
   * changes after a code was applied is re-evaluated against the code's actual
   * rules. A customer who applies "$20 off orders over $100" and then removes
   * items does not keep the twenty dollars.
   *
   * Returns a refusal rather than throwing: an inapplicable coupon is a normal
   * state of a checkout, not an error, and the checkout still has to price the
   * basket without it.
   */
  async evaluate(
    code: string,
    basket: {
      lines: DiscountableLine[];
      subtotalCents: number;
      shippingCents: number;
      customerId: string | null;
    },
  ): Promise<CouponEvaluation> {
    const normalised = code.trim().toUpperCase();
    if (normalised.length === 0) return NOT_APPLICABLE(normalised, 'NOT_FOUND');

    const coupon = await this.prisma.coupon.findFirst({
      where: { code: { equals: normalised, mode: 'insensitive' } },
    });
    // A missing code and a disabled code give the same message on purpose:
    // distinguishing them turns the checkout into an oracle for enumerating
    // valid codes.
    if (!coupon) return NOT_APPLICABLE(normalised, 'NOT_FOUND');
    if (!coupon.isActive) return NOT_APPLICABLE(normalised, 'INACTIVE');

    const now = this.clock.now();
    if (coupon.startsAt && coupon.startsAt > now) return NOT_APPLICABLE(normalised, 'NOT_STARTED');
    if (coupon.endsAt && coupon.endsAt <= now) return NOT_APPLICABLE(normalised, 'EXPIRED');

    if (coupon.requiresCustomer && !basket.customerId) {
      return NOT_APPLICABLE(normalised, 'CUSTOMER_REQUIRED');
    }

    // Counted from redemption rows. The denormalised column is display only —
    // reading it here would make the pre-check disagree with the enforcement.
    if (coupon.maxRedemptions !== null) {
      const used = await this.prisma.couponRedemption.count({ where: { couponId: coupon.id } });
      if (used >= coupon.maxRedemptions) {
        return NOT_APPLICABLE(normalised, 'USAGE_LIMIT_REACHED');
      }
    }

    if (coupon.maxPerCustomer !== null && basket.customerId) {
      const usedByCustomer = await this.prisma.couponRedemption.count({
        where: { couponId: coupon.id, customerId: basket.customerId },
      });
      if (usedByCustomer >= coupon.maxPerCustomer) {
        return NOT_APPLICABLE(normalised, 'CUSTOMER_LIMIT_REACHED');
      }
    }

    if (coupon.minSubtotalCents !== null && basket.subtotalCents < coupon.minSubtotalCents) {
      return NOT_APPLICABLE(normalised, 'MINIMUM_NOT_MET');
    }

    const eligibleCents = this.eligibleSubtotal(coupon, basket.lines);
    if (eligibleCents === 0 && coupon.type !== 'FREE_SHIPPING') {
      return NOT_APPLICABLE(normalised, 'NOT_ELIGIBLE');
    }

    const discountCents = this.valueOf(coupon, eligibleCents, basket.shippingCents);
    if (discountCents === 0 && coupon.type !== 'FREE_SHIPPING') {
      return NOT_APPLICABLE(normalised, 'NOT_ELIGIBLE');
    }

    return {
      applicable: true,
      // A free-shipping coupon never discounts goods: it is applied by pricing
      // shipping at zero, so returning a goods discount here would take the
      // money off twice.
      discountCents: coupon.type === 'FREE_SHIPPING' ? 0 : discountCents,
      freeShipping: coupon.type === 'FREE_SHIPPING',
      code: coupon.code,
      couponId: coupon.id,
      name: coupon.name,
      rejection: null,
      message: null,
    };
  }

  /**
   * Records that a coupon was used on an order, or refuses.
   *
   * Runs inside the caller's transaction — the one that places the order — so
   * the order and its redemption commit together. An order that got a discount
   * without a redemption row would be a discount nobody counted.
   *
   * The lock is on the coupon row and is taken before counting. That is the
   * whole mechanism: two concurrent redemptions of the last remaining use
   * serialise on it, and the second one counts the first one's row.
   */
  async redeemIn(
    tx: Tx,
    input: {
      couponId: string;
      orderId: string;
      customerId: string | null;
      amountCents: number;
      currency: string;
    },
  ): Promise<void> {
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM coupons WHERE id = ${input.couponId}::uuid FOR UPDATE`,
    );

    const coupon = await tx.coupon.findUnique({
      where: { id: input.couponId },
      select: { id: true, code: true, maxRedemptions: true, maxPerCustomer: true },
    });
    if (!coupon) throw AppException.notFound('Coupon');

    if (coupon.maxRedemptions !== null) {
      const used = await tx.couponRedemption.count({ where: { couponId: coupon.id } });
      if (used >= coupon.maxRedemptions) {
        throw AppException.conflict(COUPON_REJECTION_MESSAGES.USAGE_LIMIT_REACHED);
      }
    }

    if (coupon.maxPerCustomer !== null && input.customerId) {
      const usedByCustomer = await tx.couponRedemption.count({
        where: { couponId: coupon.id, customerId: input.customerId },
      });
      if (usedByCustomer >= coupon.maxPerCustomer) {
        throw AppException.conflict(COUPON_REJECTION_MESSAGES.CUSTOMER_LIMIT_REACHED);
      }
    }

    try {
      await tx.couponRedemption.create({
        data: {
          couponId: coupon.id,
          orderId: input.orderId,
          customerId: input.customerId,
          amountCents: input.amountCents,
          currency: input.currency,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        // One redemption per order, enforced by the unique constraint. A
        // retried order placement must not redeem twice.
        return;
      }
      throw error;
    }

    // Display only, and deliberately after the row that actually enforces the
    // limit. If this and the count ever disagreed, the count is right.
    await tx.coupon.update({
      where: { id: coupon.id },
      data: { redemptionCount: { increment: 1 } },
    });

    await this.audit.recordIn(tx, {
      action: LIFECYCLE_AUDIT_ACTIONS.COUPON_REDEEMED,
      entityType: 'coupon',
      entityId: coupon.id,
      actorType: 'SYSTEM',
      actorLabel: 'system',
      after: {
        code: coupon.code,
        orderId: input.orderId,
        amountCents: input.amountCents,
        customerId: input.customerId,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  async list(query: CouponQuery) {
    const now = this.clock.now();
    const rows = await this.prisma.coupon.findMany({
      where: {
        ...(query.search
          ? {
              OR: [
                { code: { contains: query.search, mode: 'insensitive' as const } },
                { name: { contains: query.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(query.activeOnly
          ? {
              isActive: true,
              OR: [{ endsAt: null }, { endsAt: { gt: now } }],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit + 1,
      include: { _count: { select: { redemptions: true } } },
    });

    return {
      data: rows.slice(0, query.limit).map((coupon) => ({
        id: coupon.id,
        code: coupon.code,
        name: coupon.name,
        type: coupon.type,
        amountCents: coupon.amountCents,
        basisPoints: coupon.basisPoints,
        minSubtotalCents: coupon.minSubtotalCents,
        maxDiscountCents: coupon.maxDiscountCents,
        maxRedemptions: coupon.maxRedemptions,
        maxPerCustomer: coupon.maxPerCustomer,
        requiresCustomer: coupon.requiresCustomer,
        // The count of real rows, not the denormalised column.
        redemptions: coupon._count.redemptions,
        startsAt: coupon.startsAt,
        endsAt: coupon.endsAt,
        isActive: coupon.isActive,
        expired: coupon.endsAt !== null && coupon.endsAt <= now,
        exhausted:
          coupon.maxRedemptions !== null && coupon._count.redemptions >= coupon.maxRedemptions,
        createdByLabel: coupon.createdByLabel,
        createdAt: coupon.createdAt,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  async create(input: CreateCouponInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    try {
      const coupon = await this.prisma.$transaction(async (tx) => {
        const created = await tx.coupon.create({
          data: {
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            type: input.type,
            amountCents: input.amountCents ?? null,
            basisPoints: input.basisPoints ?? null,
            minSubtotalCents: input.minSubtotalCents ?? null,
            maxDiscountCents: input.maxDiscountCents ?? null,
            maxRedemptions: input.maxRedemptions ?? null,
            maxPerCustomer: input.maxPerCustomer ?? null,
            eligibleProductIds: input.eligibleProductIds,
            eligibleCategoryIds: input.eligibleCategoryIds,
            requiresCustomer: input.requiresCustomer,
            startsAt: input.startsAt ?? null,
            endsAt: input.endsAt ?? null,
            isActive: input.isActive,
            createdById: actor.actorId,
            createdByLabel: actor.actorLabel,
          },
        });

        await this.audit.recordIn(tx, {
          action: LIFECYCLE_AUDIT_ACTIONS.COUPON_CREATED,
          entityType: 'coupon',
          entityId: created.id,
          actorId: actor.actorId,
          actorLabel: actor.actorLabel,
          after: {
            code: input.code,
            type: input.type,
            amountCents: input.amountCents ?? null,
            basisPoints: input.basisPoints ?? null,
            maxRedemptions: input.maxRedemptions ?? null,
          },
          ipAddress: actor.ipAddress ?? null,
          userAgent: actor.userAgent ?? null,
          correlationId: actor.correlationId,
        });

        return created;
      });

      return coupon;
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw AppException.conflict('That code already exists.');
      }
      throw error;
    }
  }

  async setActive(couponId: string, isActive: boolean, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const coupon = await this.prisma.coupon.findUnique({ where: { id: couponId } });
    if (!coupon) throw AppException.notFound('Coupon');

    await this.prisma.$transaction(async (tx) => {
      await tx.coupon.update({ where: { id: couponId }, data: { isActive } });
      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.COUPON_UPDATED,
        entityType: 'coupon',
        entityId: couponId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { isActive: coupon.isActive },
        after: { isActive, code: coupon.code },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return { id: couponId, isActive };
  }

  // -------------------------------------------------------------------------

  /**
   * The part of the basket a coupon applies to.
   *
   * With no restriction, the whole basket. With one, only lines whose product
   * or category is listed — so "20% off vitamins" discounts the vitamins and
   * not the pill organiser sitting next to them.
   */
  private eligibleSubtotal(
    coupon: { eligibleProductIds: string[]; eligibleCategoryIds: string[] },
    lines: DiscountableLine[],
  ): number {
    const restricted =
      coupon.eligibleProductIds.length > 0 || coupon.eligibleCategoryIds.length > 0;

    const products = new Set(coupon.eligibleProductIds);
    const categories = new Set(coupon.eligibleCategoryIds);

    return lines.reduce((sum, line) => {
      if (
        restricted &&
        !products.has(line.productId) &&
        !line.categoryIds.some((id) => categories.has(id))
      ) {
        return sum;
      }
      return sum + line.unitPriceCents * line.quantity;
    }, 0);
  }

  /**
   * What the coupon takes off, capped.
   *
   * Never more than the eligible goods: a discount larger than the basket would
   * make the order negative, which the pricing engine and a database constraint
   * both refuse anyway — but refusing it here means the customer sees a correct
   * total rather than an error.
   */
  private valueOf(
    coupon: {
      type: CouponType;
      amountCents: number | null;
      basisPoints: number | null;
      maxDiscountCents: number | null;
    },
    eligibleCents: number,
    shippingCents: number,
  ): number {
    if (coupon.type === 'FREE_SHIPPING') return shippingCents;

    const raw =
      coupon.type === 'PERCENTAGE'
        ? percentageDiscountCents(eligibleCents, coupon.basisPoints ?? 0)
        : (coupon.amountCents ?? 0);

    const capped = coupon.maxDiscountCents === null ? raw : Math.min(raw, coupon.maxDiscountCents);
    return Math.max(0, Math.min(capped, eligibleCents));
  }
}
