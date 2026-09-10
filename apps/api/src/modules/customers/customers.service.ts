import { Injectable } from '@nestjs/common';
import { truncateIp } from '@health/config';
import type { UpdateMarketingPreferencesInput, UpdateProfileInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { RequestAuditContext } from '../../common/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';

export interface CustomerProfileView {
  customerId: string;
  reference: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  emailVerified: boolean;
  acceptsMarketingEmail: boolean;
  acceptsMarketingSms: boolean;
  createdAt: string;
}

/**
 * Customer self-service profile.
 *
 * Every method takes the customer's *user id* from the verified session, never
 * an id from the request path — a customer cannot address another customer's
 * record even by guessing an identifier.
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async requireCustomerId(userId: string): Promise<string> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw AppException.notFound('Customer profile');
    return customer.id;
  }

  async getProfile(userId: string): Promise<CustomerProfileView> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
      include: {
        user: {
          select: {
            email: true,
            firstName: true,
            lastName: true,
            phone: true,
            emailVerifiedAt: true,
          },
        },
      },
    });
    if (!customer) throw AppException.notFound('Customer profile');

    return {
      customerId: customer.id,
      reference: customer.reference,
      email: customer.user.email,
      firstName: customer.user.firstName,
      lastName: customer.user.lastName,
      phone: customer.user.phone,
      emailVerified: customer.user.emailVerifiedAt !== null,
      acceptsMarketingEmail: customer.acceptsMarketingEmail,
      acceptsMarketingSms: customer.acceptsMarketingSms,
      createdAt: customer.createdAt.toISOString(),
    };
  }

  async updateProfile(
    userId: string,
    input: UpdateProfileInput,
    context: RequestAuditContext,
  ): Promise<CustomerProfileView> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw AppException.notFound('Customer profile');

    const before = { firstName: user.firstName, lastName: user.lastName, phone: user.phone };

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
        },
      });
      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.CUSTOMER_PROFILE_UPDATED,
        entityType: 'user',
        entityId: userId,
        actorId: userId,
        actorLabel: user.email,
        before,
        after: { ...before, ...input },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });

    return this.getProfile(userId);
  }

  /**
   * Marketing preferences are mirrored onto the customer row (for fast reads)
   * and appended to the immutable consent ledger (for evidence). The ledger is
   * the record of truth if the two ever disagree.
   */
  async updateMarketingPreferences(
    userId: string,
    input: UpdateMarketingPreferencesInput,
    context: RequestAuditContext,
  ): Promise<CustomerProfileView> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
    });
    if (!customer) throw AppException.notFound('Customer profile');

    const before = {
      acceptsMarketingEmail: customer.acceptsMarketingEmail,
      acceptsMarketingSms: customer.acceptsMarketingSms,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.customer.update({
        where: { id: customer.id },
        data: {
          acceptsMarketingEmail: input.acceptsMarketingEmail,
          acceptsMarketingSms: input.acceptsMarketingSms,
        },
      });

      const entries: Array<{ type: 'MARKETING_EMAIL' | 'MARKETING_SMS'; granted: boolean }> = [];
      if (input.acceptsMarketingEmail !== before.acceptsMarketingEmail) {
        entries.push({ type: 'MARKETING_EMAIL', granted: input.acceptsMarketingEmail });
      }
      if (input.acceptsMarketingSms !== before.acceptsMarketingSms) {
        entries.push({ type: 'MARKETING_SMS', granted: input.acceptsMarketingSms });
      }

      if (entries.length > 0) {
        await tx.customerConsent.createMany({
          data: entries.map((entry) => ({
            customerId: customer.id,
            type: entry.type,
            granted: entry.granted,
            source: 'account_preferences',
            ipAddress: truncateIp(context.ipAddress),
            userAgent: context.userAgent,
          })),
        });
      }

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.CUSTOMER_CONSENT_RECORDED,
        entityType: 'customer',
        entityId: customer.id,
        actorId: userId,
        before,
        after: input,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });

    return this.getProfile(userId);
  }

  async listConsents(
    userId: string,
  ): Promise<
    Array<{ type: string; granted: boolean; documentVersion: string | null; recordedAt: string }>
  > {
    const customerId = await this.requireCustomerId(userId);
    const consents = await this.prisma.customerConsent.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return consents.map((consent) => ({
      type: consent.type,
      granted: consent.granted,
      documentVersion: consent.documentVersion,
      recordedAt: consent.createdAt.toISOString(),
    }));
  }
}
