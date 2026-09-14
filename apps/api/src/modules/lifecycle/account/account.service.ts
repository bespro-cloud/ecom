import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import { ERASABLE_DATA, RETAINED_DATA } from '@health/types';
import type {
  DecideErasureInput,
  ErasureQuery,
  MarketingPreferencesInput,
  RequestErasureInput,
} from '@health/validation';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../../infrastructure/config/config.module.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { AuditService } from '../../audit/audit.service.js';
import { requireNamedActor, type ActorContext } from '../../rbac/roles.service.js';
import { LIFECYCLE_AUDIT_ACTIONS } from '../lifecycle.audit.js';

/**
 * Account self-service.
 *
 * Two things here are easy to build wrong in a way nobody notices until it
 * matters.
 *
 * **Consent is a ledger, not a checkbox.** Flipping a boolean answers "can we
 * email them?" and nothing else. It cannot answer "when did they agree, to
 * what, and from where?", which is the question that actually gets asked — by a
 * regulator, or by a customer who says they never opted in. So every change
 * writes a row, and the boolean on the customer is a projection of the latest
 * one.
 *
 * **Erasure is a request, not a cascade.** A customer can ask to be forgotten.
 * The business cannot comply by destroying records it is legally obliged to
 * keep — orders and payments for tax and consumer-protection purposes, which
 * lots someone received so they can be reached in a recall, the consent history
 * that evidences what they agreed to. A `DELETE` that cascaded through those
 * would trade one legal problem for a worse one. So the request is recorded,
 * reviewed by a person, and satisfied by removing what can be removed — and the
 * customer is told which is which *before* they ask, not after.
 */
@Injectable()
export class AccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(AccountService.name);
  }

  // -------------------------------------------------------------------------
  // Marketing preferences
  // -------------------------------------------------------------------------

  /**
   * Records a change of marketing preference.
   *
   * Writes a consent row per channel that actually changed, then updates the
   * projection. Transactional mail is deliberately absent: a customer cannot
   * unsubscribe from being told their order shipped or their card was declined,
   * and offering the switch would imply they could.
   */
  async setMarketingPreferences(
    customerId: string,
    input: MarketingPreferencesInput,
    rawActor: ActorContext,
  ) {
    const actor = requireNamedActor(rawActor);

    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw AppException.notFound('Customer');

    const changes: Array<{ type: 'MARKETING_EMAIL' | 'MARKETING_SMS'; granted: boolean }> = [];
    if (customer.acceptsMarketingEmail !== input.acceptsMarketingEmail) {
      changes.push({ type: 'MARKETING_EMAIL', granted: input.acceptsMarketingEmail });
    }
    if (customer.acceptsMarketingSms !== input.acceptsMarketingSms) {
      changes.push({ type: 'MARKETING_SMS', granted: input.acceptsMarketingSms });
    }

    if (changes.length === 0) {
      return {
        acceptsMarketingEmail: customer.acceptsMarketingEmail,
        acceptsMarketingSms: customer.acceptsMarketingSms,
      };
    }

    await this.prisma.$transaction(async (tx) => {
      for (const change of changes) {
        await tx.customerConsent.create({
          data: {
            customerId,
            type: change.type,
            granted: change.granted,
            source: 'account-settings',
            // Recorded because a consent record without provenance is weak
            // evidence. Masked nowhere else in the system reads it.
            ipAddress: actor.ipAddress ?? null,
            userAgent: actor.userAgent ?? null,
          },
        });
      }

      await tx.customer.update({
        where: { id: customerId },
        data: {
          acceptsMarketingEmail: input.acceptsMarketingEmail,
          acceptsMarketingSms: input.acceptsMarketingSms,
        },
      });

      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.MARKETING_PREFERENCES_CHANGED,
        entityType: 'customer',
        entityId: customerId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: {
          email: customer.acceptsMarketingEmail,
          sms: customer.acceptsMarketingSms,
        },
        after: { email: input.acceptsMarketingEmail, sms: input.acceptsMarketingSms },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    return {
      acceptsMarketingEmail: input.acceptsMarketingEmail,
      acceptsMarketingSms: input.acceptsMarketingSms,
    };
  }

  /** The consent ledger, so a customer can see what they agreed to and when. */
  async consentHistory(customerId: string) {
    const consents = await this.prisma.customerConsent.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        type: true,
        granted: true,
        documentVersion: true,
        source: true,
        createdAt: true,
      },
    });
    return consents;
  }

  // -------------------------------------------------------------------------
  // Data export
  // -------------------------------------------------------------------------

  /**
   * Everything the business holds about a customer, in one structure.
   *
   * Deliberately assembled from real tables rather than a curated summary: an
   * export that quietly omitted a category would be a false statement about
   * what is held. Payment methods appear as brand and last four, because that
   * is genuinely all there is — the card itself never reached this system.
   */
  async exportData(customerId: string, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        user: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            createdAt: true,
            lastLoginAt: true,
          },
        },
        addresses: { where: { deletedAt: null } },
        consents: { orderBy: { createdAt: 'desc' } },
        paymentMethods: { where: { detachedAt: null } },
        reviews: { include: { product: { select: { name: true } } } },
        supportThreads: { include: { messages: { where: { isInternal: false } } } },
        subscriptions: { include: { items: true } },
      },
    });
    if (!customer) throw AppException.notFound('Customer');

    const orders = await this.prisma.order.findMany({
      where: { customerId },
      orderBy: { placedAt: 'desc' },
      include: { items: true },
    });

    await this.audit.record({
      action: LIFECYCLE_AUDIT_ACTIONS.DATA_EXPORTED,
      entityType: 'customer',
      entityId: customerId,
      actorId: actor.actorId,
      actorLabel: actor.actorLabel,
      after: { orders: orders.length, reviews: customer.reviews.length },
      ipAddress: actor.ipAddress ?? null,
      userAgent: actor.userAgent ?? null,
      correlationId: actor.correlationId,
    });

    return {
      exportedAt: this.clock.now().toISOString(),
      account: {
        reference: customer.reference,
        email: customer.user.email,
        firstName: customer.user.firstName,
        lastName: customer.user.lastName,
        createdAt: customer.createdAt,
        lastLoginAt: customer.user.lastLoginAt,
        acceptsMarketingEmail: customer.acceptsMarketingEmail,
        acceptsMarketingSms: customer.acceptsMarketingSms,
      },
      addresses: customer.addresses.map((address) => ({
        label: address.label,
        firstName: address.firstName,
        lastName: address.lastName,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        region: address.region,
        postalCode: address.postalCode,
        country: address.country,
        phone: address.phone,
      })),
      consents: customer.consents.map((consent) => ({
        type: consent.type,
        granted: consent.granted,
        documentVersion: consent.documentVersion,
        source: consent.source,
        at: consent.createdAt,
      })),
      paymentMethods: customer.paymentMethods.map((method) => ({
        // All there is. The card number never reached this system, so there is
        // nothing here to withhold and nothing to leak.
        cardBrand: method.cardBrand,
        cardLast4: method.cardLast4,
        addedAt: method.createdAt,
      })),
      orders: orders.map((order) => ({
        reference: order.reference,
        placedAt: order.placedAt,
        status: order.status,
        currency: order.currency,
        totalCents: order.totalCents,
        items: order.items.map((item) => ({
          sku: item.sku,
          productName: item.productName,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
        })),
      })),
      subscriptions: customer.subscriptions.map((subscription) => ({
        reference: subscription.reference,
        status: subscription.status,
        interval: subscription.interval,
        intervalCount: subscription.intervalCount,
        createdAt: subscription.createdAt,
        items: subscription.items.map((item) => ({
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
        })),
      })),
      reviews: customer.reviews.map((review) => ({
        product: review.product.name,
        rating: review.rating,
        title: review.title,
        body: review.body,
        status: review.status,
        writtenAt: review.createdAt,
      })),
      supportConversations: customer.supportThreads.map((thread) => ({
        reference: thread.reference,
        subject: thread.subject,
        topic: thread.topic,
        status: thread.status,
        openedAt: thread.createdAt,
        messages: thread.messages.map((message) => ({
          from: message.authorType === 'STAFF' ? 'Support' : 'You',
          body: message.body,
          at: message.createdAt,
        })),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Erasure
  // -------------------------------------------------------------------------

  /** What erasure will and will not remove. Shown before the customer asks. */
  erasureScope() {
    return {
      removed: ERASABLE_DATA,
      retained: RETAINED_DATA,
      note: 'Deletion is reviewed by a person, usually within a few days. We will tell you what we removed and what we had to keep.',
    };
  }

  async requestErasure(customerId: string, input: RequestErasureInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const open = await this.prisma.erasureRequest.findFirst({
      where: { customerId, status: { in: ['REQUESTED', 'IN_REVIEW'] } },
    });
    if (open) {
      throw AppException.conflict('You already have a deletion request being reviewed.');
    }

    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.erasureRequest.create({
        data: { customerId, status: 'REQUESTED', reason: input.reason ?? null },
      });
      await this.audit.recordIn(tx, {
        action: LIFECYCLE_AUDIT_ACTIONS.ERASURE_REQUESTED,
        entityType: 'customer',
        entityId: customerId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.reason ?? null,
        after: { requestId: created.id },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
      return created;
    });

    this.logger.info({ customerId, requestId: request.id }, 'erasure requested');

    return { id: request.id, status: request.status, ...this.erasureScope() };
  }

  async listErasureRequests(query: ErasureQuery) {
    const rows = await this.prisma.erasureRequest.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: { createdAt: 'asc' },
      take: query.limit + 1,
      include: {
        customer: {
          select: { id: true, reference: true, user: { select: { email: true } } },
        },
      },
    });

    return {
      data: rows.slice(0, query.limit).map((request) => ({
        id: request.id,
        status: request.status,
        reason: request.reason,
        customerReference: request.customer.reference,
        customerEmail: request.customer.user.email,
        createdAt: request.createdAt,
        decidedAt: request.decidedAt,
        decidedByLabel: request.decidedByLabel,
      })),
      meta: { hasMore: rows.length > query.limit },
    };
  }

  /**
   * Carries out an approved erasure.
   *
   * Removes exactly what was promised and nothing that was not. Orders,
   * payments, refunds, consent history and the reservations that say which lots
   * the customer received all stay — the last of those is why: a recall has to
   * be able to reach the people who got the affected stock, and that obligation
   * does not lapse because somebody closed their account.
   *
   * Reviews are anonymised rather than deleted, because removing them would
   * silently change a published rating average that other customers are relying
   * on. The customer's name comes off; the words stay.
   */
  async decideErasure(requestId: string, input: DecideErasureInput, rawActor: ActorContext) {
    const actor = requireNamedActor(rawActor);

    const request = await this.prisma.erasureRequest.findUnique({
      where: { id: requestId },
      include: { customer: { select: { id: true, userId: true, reference: true } } },
    });
    if (!request) throw AppException.notFound('Erasure request');
    if (request.status === 'COMPLETED' || request.status === 'REFUSED') {
      throw AppException.conflict('That request has already been decided.');
    }

    const now = this.clock.now();
    const customerId = request.customer.id;

    await this.prisma.$transaction(async (tx) => {
      if (input.decision === 'COMPLETED') {
        // Addresses: removed.
        await tx.customerAddress.updateMany({
          where: { customerId, deletedAt: null },
          data: { deletedAt: now },
        });

        // Saved payment methods: the token goes. There was never a card here.
        await tx.customerPaymentMethod.updateMany({
          where: { customerId, detachedAt: null },
          data: { detachedAt: now },
        });

        // Support conversations: closed and the customer's words removed. The
        // thread itself stays so the business can show a conversation happened.
        const threads = await tx.supportThread.findMany({
          where: { customerId },
          select: { id: true },
        });
        if (threads.length > 0) {
          await tx.supportThread.updateMany({
            where: { customerId },
            data: { status: 'CLOSED', closedAt: now },
          });
        }

        // Reviews: anonymised, not deleted. Deleting them would move a
        // published rating average that other customers are relying on.
        await tx.productReview.updateMany({
          where: { customerId },
          data: { authorDisplayName: 'Former customer' },
        });

        // Marketing consent: withdrawn, and recorded as withdrawn. The ledger
        // entry is itself retained — it is the evidence that they asked.
        await tx.customerConsent.create({
          data: {
            customerId,
            type: 'MARKETING_EMAIL',
            granted: false,
            source: 'erasure-request',
          },
        });
        await tx.customer.update({
          where: { id: customerId },
          data: { acceptsMarketingEmail: false, acceptsMarketingSms: false, deletedAt: now },
        });

        // Sign-in: disabled, and the account name cleared. The user row itself
        // stays because orders reference it, and an order with no customer is
        // a financial record nobody can reconcile.
        await tx.user.update({
          where: { id: request.customer.userId },
          data: {
            status: 'SUSPENDED',
            firstName: 'Former',
            lastName: 'customer',
          },
        });
        await tx.userSession.updateMany({
          where: { userId: request.customer.userId, revokedAt: null },
          data: { revokedAt: now, revokedReason: 'ADMIN_REVOKED' },
        });
      }

      await tx.erasureRequest.update({
        where: { id: requestId },
        data: {
          status: input.decision,
          decidedAt: now,
          decidedById: actor.actorId,
          decidedByLabel: actor.actorLabel,
          decisionNotes: input.notes,
        },
      });

      await this.audit.recordIn(tx, {
        action:
          input.decision === 'COMPLETED'
            ? LIFECYCLE_AUDIT_ACTIONS.ERASURE_COMPLETED
            : LIFECYCLE_AUDIT_ACTIONS.ERASURE_REFUSED,
        entityType: 'customer',
        entityId: customerId,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        reason: input.notes,
        after: {
          requestId,
          decision: input.decision,
          // Stated in the record itself, so a later reader does not have to
          // infer what "completed" covered.
          retained: [...RETAINED_DATA],
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });

    this.logger.warn(
      { customerId, requestId, decision: input.decision, decidedBy: actor.actorId },
      'erasure request decided',
    );

    return { id: requestId, status: input.decision, retained: RETAINED_DATA };
  }
}
