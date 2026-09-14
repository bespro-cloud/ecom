import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  couponQuerySchema,
  createCouponSchema,
  decideErasureSchema,
  erasureQuerySchema,
  moderateReviewSchema,
  reviewQuerySchema,
  subscriptionQuerySchema,
  supportQuerySchema,
  supportReplySchema,
  supportStatusSchema,
  uuidSchema,
  type CouponQuery,
  type CreateCouponInput,
  type DecideErasureInput,
  type ErasureQuery,
  type ModerateReviewInput,
  type ReviewQuery,
  type SubscriptionQuery,
  type SupportQuery,
  type SupportReplyInput,
  type SupportStatusInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { ReviewsService } from './reviews/reviews.service.js';
import { CouponsService } from './coupons/coupons.service.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { SupportService } from './support/support.service.js';
import { AccountService } from './account/account.service.js';

const setActiveSchema = z.object({ isActive: z.boolean() });

/**
 * Customer-lifecycle administration.
 *
 * Two permission choices are worth stating.
 *
 * `REVIEW_MODERATE` is what publishes a review. It is the control that decides
 * whether customer-written text about a health product appears on a public
 * listing, which is why every decision needs written reasoning and why the
 * moderation screen shows a health-claim prompt rather than a verdict.
 *
 * Deciding an erasure request requires MFA and `CUSTOMER_ERASE`, which is
 * separate from `CUSTOMER_WRITE`: correcting a misspelled name and erasing
 * somebody's data are not the same authority. It removes a
 * person's data and is not reversible, which is the same bar that puts a second
 * factor on issuing a refund.
 */
@ApiTags('Customer lifecycle')
@Controller({ path: 'admin/lifecycle', version: '1' })
export class LifecycleAdminController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly coupons: CouponsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly support: SupportService,
    private readonly account: AccountService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  // --- review moderation ---------------------------------------------------

  @Get('reviews')
  @RequirePermissions('REVIEW_READ')
  @ApiOperation({
    summary: 'The moderation queue',
    description:
      'Oldest first. Reviews whose wording prompted a health-claim check carry the matched terms, which are advisory only — nothing in the system acts on them.',
  })
  async listReviews(@Query(zodBody(reviewQuerySchema)) query: ReviewQuery) {
    return this.reviews.listForModeration(query);
  }

  @Get('reviews/:id')
  @RequirePermissions('REVIEW_READ')
  @ApiOperation({ summary: 'One review with its moderation history' })
  async findReview(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.reviews.findById(id);
  }

  @Post('reviews/:id/moderate')
  @RequirePermissions('REVIEW_MODERATE')
  @ApiOperation({
    summary: 'Publish, reject, escalate or withdraw a review',
    description:
      'Written reasoning is required on every outcome, publication included. Escalation hands the decision to compliance and cannot be taken back.',
  })
  async moderateReview(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(moderateReviewSchema)) input: ModerateReviewInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.reviews.moderate(id, input, this.actor(principal, request));
  }

  // --- coupons -------------------------------------------------------------

  @Get('coupons')
  @RequirePermissions('COUPON_READ')
  @ApiOperation({ summary: 'Discount codes' })
  async listCoupons(@Query(zodBody(couponQuerySchema)) query: CouponQuery) {
    return this.coupons.list(query);
  }

  @Post('coupons')
  @RequirePermissions('COUPON_WRITE')
  @ApiOperation({
    summary: 'Create a discount code',
    description:
      'Usage limits are enforced by counting redemption rows under a lock, not by a counter — two concurrent checkouts cannot both take the last remaining use.',
  })
  async createCoupon(
    @Body(zodBody(createCouponSchema)) input: CreateCouponInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.coupons.create(input, this.actor(principal, request));
  }

  @Post('coupons/:id/active')
  @RequirePermissions('COUPON_WRITE')
  @ApiOperation({ summary: 'Switch a code on or off' })
  async setCouponActive(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(setActiveSchema)) input: { isActive: boolean },
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.coupons.setActive(id, input.isActive, this.actor(principal, request));
  }

  // --- subscriptions -------------------------------------------------------

  @Get('subscriptions')
  @RequirePermissions('SUBSCRIPTION_READ')
  @ApiOperation({ summary: 'Subscriptions' })
  async listSubscriptions(@Query(zodBody(subscriptionQuerySchema)) query: SubscriptionQuery) {
    return this.subscriptions.list(query);
  }

  @Get('subscriptions/:id')
  @RequirePermissions('SUBSCRIPTION_READ')
  @ApiOperation({ summary: 'One subscription, with its event history' })
  async findSubscription(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.subscriptions.findById(id);
  }

  // --- support -------------------------------------------------------------

  @Get('support')
  @RequirePermissions('SUPPORT_READ')
  @ApiOperation({ summary: 'The support inbox' })
  async listThreads(@Query(zodBody(supportQuerySchema)) query: SupportQuery) {
    return this.support.list(query);
  }

  @Get('support/:id')
  @RequirePermissions('SUPPORT_READ')
  @ApiOperation({ summary: 'One conversation, internal notes included' })
  async findThread(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.support.findForStaff(id);
  }

  @Post('support/:id/replies')
  @RequirePermissions('SUPPORT_WRITE')
  @ApiOperation({
    summary: 'Reply, or add an internal note',
    description:
      'An internal note is never shown to the customer and does not notify them — a notification about a note about them would be a leak by another route.',
  })
  async reply(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(supportReplySchema)) input: SupportReplyInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.support.replyAsStaff(id, input, this.actor(principal, request));
  }

  @Post('support/:id/status')
  @RequirePermissions('SUPPORT_WRITE')
  @ApiOperation({ summary: 'Change a conversation status' })
  async setThreadStatus(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(supportStatusSchema)) input: SupportStatusInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.support.setStatus(id, input, this.actor(principal, request));
  }

  // --- erasure -------------------------------------------------------------

  @Get('erasure-requests')
  @RequirePermissions('CUSTOMER_READ')
  @ApiOperation({ summary: 'Deletion requests awaiting a decision' })
  async listErasure(@Query(zodBody(erasureQuerySchema)) query: ErasureQuery) {
    return this.account.listErasureRequests(query);
  }

  @Post('erasure-requests/:id/decision')
  @RequirePermissions('CUSTOMER_ERASE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Decide a deletion request',
    description:
      'Removes what can be removed and keeps what must be kept — orders, payments, consent history and which lots the customer received, the last so they can be reached in a recall. Requires MFA: this is not reversible.',
  })
  async decideErasure(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(decideErasureSchema)) input: DecideErasureInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.account.decideErasure(id, input, this.actor(principal, request));
  }
}
