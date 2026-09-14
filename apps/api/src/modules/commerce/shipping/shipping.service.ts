import { Injectable } from '@nestjs/common';
import { quoteShippingRates, type ShippingQuote } from '@health/types';
import type { CreateShippingRateInput, OrderAddressInput } from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { COMMERCE_AUDIT_ACTIONS } from '../commerce.audit.js';
import type { ActorContext } from '../../rbac/roles.service.js';

export interface ShippingContext {
  address: Pick<OrderAddressInput, 'country' | 'region'>;
  subtotalCents: number;
  totalWeightGrams: number;
}

/**
 * Shipping rates.
 *
 * Rates are configuration rather than code, because what a business charges for
 * delivery changes without a deploy, and because the person who decides it is
 * not a developer.
 *
 * The quoting rule that matters: **a rate the customer was shown must be the
 * rate they are charged.** Checkout re-quotes and refuses a method that no
 * longer applies, rather than substituting a different one — silently
 * upgrading someone to a pricier delivery is worse than telling them to choose
 * again.
 */
@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Rates available for a destination and basket.
   *
   * Free-shipping thresholds are applied here rather than as a discount, so the
   * customer sees "Free" against the method rather than a line item that needs
   * explaining.
   */
  async quote(context: ShippingContext): Promise<ShippingQuote[]> {
    const candidates = await this.prisma.shippingRate.findMany({
      where: { isActive: true, countries: { has: context.address.country } },
      orderBy: [{ position: 'asc' }, { priceCents: 'asc' }],
    });

    // Which rates apply is decided by a pure function in `@health/types`, not
    // here, so that a subscription renewal charges the same delivery cost this
    // quote showed at checkout. Two implementations of that rule would drift.
    return quoteShippingRates(candidates, {
      country: context.address.country,
      region: context.address.region,
      subtotalCents: context.subtotalCents,
      totalWeightGrams: context.totalWeightGrams,
    });
  }

  /**
   * Re-quotes one method, for checkout.
   *
   * Returns null when the method no longer applies — the basket changed, the
   * address changed, the rate was withdrawn. The caller's job is then to make
   * the customer choose again, not to pick something for them.
   */
  async quoteOne(code: string, context: ShippingContext): Promise<ShippingQuote | null> {
    const quotes = await this.quote(context);
    return quotes.find((quote) => quote.code === code) ?? null;
  }

  async list(includeInactive = false) {
    return this.prisma.shippingRate.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ position: 'asc' }, { priceCents: 'asc' }],
    });
  }

  async create(input: CreateShippingRateInput, actor: ActorContext) {
    const existing = await this.prisma.shippingRate.findUnique({ where: { code: input.code } });
    if (existing) {
      throw AppException.conflict(`A shipping rate with the code "${input.code}" already exists.`);
    }

    const rate = await this.prisma.$transaction(async (tx) => {
      const created = await tx.shippingRate.create({
        data: {
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          countries: input.countries,
          regions: input.regions,
          priceCents: input.priceCents,
          freeAboveSubtotalCents: input.freeAboveSubtotalCents ?? null,
          minWeightGrams: input.minWeightGrams ?? null,
          maxWeightGrams: input.maxWeightGrams ?? null,
          minSubtotalCents: input.minSubtotalCents ?? null,
          maxSubtotalCents: input.maxSubtotalCents ?? null,
          estimatedDaysMin: input.estimatedDaysMin ?? null,
          estimatedDaysMax: input.estimatedDaysMax ?? null,
          position: input.position,
          isActive: input.isActive,
        },
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.SHIPPING_RATE_CREATED,
        entityType: 'shipping_rate',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: { code: created.code, priceCents: created.priceCents },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    return rate;
  }

  async update(id: string, input: Partial<CreateShippingRateInput>, actor: ActorContext) {
    const existing = await this.prisma.shippingRate.findUnique({ where: { id } });
    if (!existing) throw AppException.notFound('Shipping rate');

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.shippingRate.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description ?? null } : {}),
          ...(input.countries !== undefined ? { countries: input.countries } : {}),
          ...(input.regions !== undefined ? { regions: input.regions } : {}),
          ...(input.priceCents !== undefined ? { priceCents: input.priceCents } : {}),
          ...(input.freeAboveSubtotalCents !== undefined
            ? { freeAboveSubtotalCents: input.freeAboveSubtotalCents ?? null }
            : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.position !== undefined ? { position: input.position } : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: COMMERCE_AUDIT_ACTIONS.SHIPPING_RATE_UPDATED,
        entityType: 'shipping_rate',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { priceCents: existing.priceCents, isActive: existing.isActive },
        after: { priceCents: updated.priceCents, isActive: updated.isActive },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return updated;
    });
  }
}
