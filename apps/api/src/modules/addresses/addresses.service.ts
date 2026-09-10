import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Clock } from '@health/config';
import type { AddressInput, UpdateAddressInput } from '@health/validation';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { RequestAuditContext } from '../../common/request-context.js';
import { AuditService } from '../audit/audit.service.js';
import { AUDIT_ACTIONS } from '../audit/audit.types.js';
import { CustomersService } from '../customers/customers.service.js';

export interface AddressView {
  id: string;
  type: string;
  label: string | null;
  firstName: string;
  lastName: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string | null;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}

/**
 * Customer address book.
 *
 * Two things worth noting:
 *
 *  - Every query is scoped by the customer id derived from the session, so an
 *    address id belonging to someone else simply does not exist as far as this
 *    service is concerned (404, not 403 — we do not confirm it exists).
 *  - "Default" flags are maintained inside a transaction that first clears the
 *    previous default. A partial unique index backs this up at the database
 *    level, so a race cannot leave two defaults behind.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly customers: CustomersService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async list(userId: string): Promise<AddressView[]> {
    const customerId = await this.customers.requireCustomerId(userId);
    const addresses = await this.prisma.customerAddress.findMany({
      where: { customerId, deletedAt: null },
      orderBy: [{ isDefaultShipping: 'desc' }, { createdAt: 'desc' }],
    });
    return addresses.map(toView);
  }

  async create(
    userId: string,
    input: AddressInput,
    context: RequestAuditContext,
  ): Promise<AddressView> {
    const customerId = await this.customers.requireCustomerId(userId);
    const existingCount = await this.prisma.customerAddress.count({
      where: { customerId, deletedAt: null },
    });

    // The first address a customer saves becomes their default, so checkout
    // has something to pre-fill without them having to think about it.
    const isFirst = existingCount === 0;
    const isDefaultShipping = input.isDefaultShipping || isFirst;
    const isDefaultBilling = input.isDefaultBilling || isFirst;

    const created = await this.prisma.$transaction(async (tx) => {
      await this.clearDefaults(tx, customerId, { isDefaultShipping, isDefaultBilling });

      const address = await tx.customerAddress.create({
        data: {
          customerId,
          type: input.type,
          label: input.label ?? null,
          firstName: input.firstName,
          lastName: input.lastName,
          company: input.company ?? null,
          line1: input.line1,
          line2: input.line2 ?? null,
          city: input.city,
          region: input.region,
          postalCode: input.postalCode,
          country: input.country,
          phone: input.phone ?? null,
          isDefaultShipping,
          isDefaultBilling,
        },
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.CUSTOMER_ADDRESS_CREATED,
        entityType: 'customer_address',
        entityId: address.id,
        actorId: userId,
        after: { city: address.city, region: address.region, postalCode: address.postalCode },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });

      return address;
    });

    return toView(created);
  }

  async update(
    userId: string,
    addressId: string,
    input: UpdateAddressInput,
    context: RequestAuditContext,
  ): Promise<AddressView> {
    const customerId = await this.customers.requireCustomerId(userId);
    const existing = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Address');

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.clearDefaults(
        tx,
        customerId,
        {
          isDefaultShipping: input.isDefaultShipping ?? false,
          isDefaultBilling: input.isDefaultBilling ?? false,
        },
        addressId,
      );

      const address = await tx.customerAddress.update({
        where: { id: addressId },
        data: {
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
          ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
          ...(input.company !== undefined ? { company: input.company } : {}),
          ...(input.line1 !== undefined ? { line1: input.line1 } : {}),
          ...(input.line2 !== undefined ? { line2: input.line2 } : {}),
          ...(input.city !== undefined ? { city: input.city } : {}),
          ...(input.region !== undefined ? { region: input.region } : {}),
          ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
          ...(input.country !== undefined ? { country: input.country } : {}),
          ...(input.phone !== undefined ? { phone: input.phone } : {}),
          ...(input.isDefaultShipping !== undefined
            ? { isDefaultShipping: input.isDefaultShipping }
            : {}),
          ...(input.isDefaultBilling !== undefined
            ? { isDefaultBilling: input.isDefaultBilling }
            : {}),
        },
      });

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.CUSTOMER_ADDRESS_UPDATED,
        entityType: 'customer_address',
        entityId: addressId,
        actorId: userId,
        before: { city: existing.city, region: existing.region, postalCode: existing.postalCode },
        after: { city: address.city, region: address.region, postalCode: address.postalCode },
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });

      return address;
    });

    return toView(updated);
  }

  /**
   * Soft delete: an address may be referenced by a historical order, and a
   * shipped-to address is part of the commercial record. The row leaves the
   * customer's address book but stays available to order history.
   */
  async remove(userId: string, addressId: string, context: RequestAuditContext): Promise<void> {
    const customerId = await this.customers.requireCustomerId(userId);
    const existing = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId, deletedAt: null },
    });
    if (!existing) throw AppException.notFound('Address');

    await this.prisma.$transaction(async (tx) => {
      await tx.customerAddress.update({
        where: { id: addressId },
        data: { deletedAt: this.clock.now(), isDefaultShipping: false, isDefaultBilling: false },
      });

      // Promote another address so the customer is not left with none.
      if (existing.isDefaultShipping || existing.isDefaultBilling) {
        const replacement = await tx.customerAddress.findFirst({
          where: { customerId, deletedAt: null, id: { not: addressId } },
          orderBy: { createdAt: 'desc' },
        });
        if (replacement) {
          await tx.customerAddress.update({
            where: { id: replacement.id },
            data: {
              isDefaultShipping: existing.isDefaultShipping || replacement.isDefaultShipping,
              isDefaultBilling: existing.isDefaultBilling || replacement.isDefaultBilling,
            },
          });
        }
      }

      await this.audit.recordIn(tx, {
        action: AUDIT_ACTIONS.CUSTOMER_ADDRESS_DELETED,
        entityType: 'customer_address',
        entityId: addressId,
        actorId: userId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        correlationId: context.correlationId,
      });
    });
  }

  private async clearDefaults(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    customerId: string,
    flags: { isDefaultShipping: boolean; isDefaultBilling: boolean },
    exceptId?: string,
  ): Promise<void> {
    if (flags.isDefaultShipping) {
      await tx.customerAddress.updateMany({
        where: {
          customerId,
          isDefaultShipping: true,
          deletedAt: null,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        data: { isDefaultShipping: false },
      });
    }
    if (flags.isDefaultBilling) {
      await tx.customerAddress.updateMany({
        where: {
          customerId,
          isDefaultBilling: true,
          deletedAt: null,
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        data: { isDefaultBilling: false },
      });
    }
  }
}

function toView(address: {
  id: string;
  type: string;
  label: string | null;
  firstName: string;
  lastName: string;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string | null;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}): AddressView {
  return {
    id: address.id,
    type: address.type,
    label: address.label,
    firstName: address.firstName,
    lastName: address.lastName,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone,
    isDefaultShipping: address.isDefaultShipping,
    isDefaultBilling: address.isDefaultBilling,
  };
}
