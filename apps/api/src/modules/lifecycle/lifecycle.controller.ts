import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  attachPaymentMethodSchema,
  cancelSubscriptionSchema,
  createReviewSchema,
  createSubscriptionSchema,
  createSupportThreadSchema,
  marketingPreferencesSchema,
  pauseSubscriptionSchema,
  requestErasureSchema,
  supportReplySchema,
  updateSubscriptionSchema,
  uuidSchema,
  type AttachPaymentMethodInput,
  type CancelSubscriptionInput,
  type CreateReviewInput,
  type CreateSubscriptionInput,
  type CreateSupportThreadInput,
  type MarketingPreferencesInput,
  type PauseSubscriptionInput,
  type RequestErasureInput,
  type SupportReplyInput,
  type UpdateSubscriptionInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { AppException } from '../../common/errors/app-exception.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { ReviewsService } from './reviews/reviews.service.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { SupportService } from './support/support.service.js';
import { AccountService } from './account/account.service.js';

/**
 * The customer's own lifecycle: their reviews, subscriptions, conversations
 * and account.
 *
 * Every route resolves the caller's customer record from the session and scopes
 * the query by it. No route takes a customer id from the request — an id in a
 * body is a suggestion, and on these endpoints acting on one would mean reading
 * somebody else's support conversation or cancelling their subscription.
 */
@ApiTags('Account')
@Controller({ path: 'account', version: '1' })
export class AccountLifecycleController {
  constructor(
    private readonly reviews: ReviewsService,
    private readonly subscriptions: SubscriptionsService,
    private readonly support: SupportService,
    private readonly account: AccountService,
    private readonly prisma: PrismaService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  private async customerId(userId: string): Promise<string> {
    const customer = await this.prisma.customer.findFirst({
      where: { userId, deletedAt: null },
      select: { id: true },
    });
    if (!customer) throw AppException.notFound('Customer');
    return customer.id;
  }

  // --- reviews -------------------------------------------------------------

  @Post('reviews')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Write a review',
    description:
      'Never immediately visible. Every review is read by a moderator first, and the response says so.',
  })
  async writeReview(
    @Body(zodBody(createReviewSchema)) input: CreateReviewInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.reviews.create(customerId, input, this.actor(principal, request));
  }

  @Get('reviews')
  @ApiOperation({ summary: 'Your reviews, including ones not yet published' })
  async myReviews(@CurrentUser() principal: AuthenticatedPrincipal) {
    return { data: await this.reviews.listForCustomer(await this.customerId(principal.userId)) };
  }

  // --- payment methods -----------------------------------------------------

  @Get('payment-methods')
  @ApiOperation({
    summary: 'Your saved cards',
    description: 'Brand and last four only. The card itself never reached this application.',
  })
  async paymentMethods(@CurrentUser() principal: AuthenticatedPrincipal) {
    return {
      data: await this.subscriptions.listPaymentMethods(await this.customerId(principal.userId)),
    };
  }

  @Post('payment-methods')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Save a card',
    description:
      'Takes the provider token the browser received after sending the card to the provider directly. There is no field here for a card number.',
  })
  async attachPaymentMethod(
    @Body(zodBody(attachPaymentMethodSchema)) input: AttachPaymentMethodInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.subscriptions.attachPaymentMethod(
      customerId,
      input,
      this.actor(principal, request),
    );
  }

  @Delete('payment-methods/:id')
  @ApiOperation({
    summary: 'Remove a card',
    description: 'Refused while a live subscription still bills to it.',
  })
  async detachPaymentMethod(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    const customerId = await this.customerId(principal.userId);
    await this.subscriptions.detachPaymentMethod(customerId, id, this.actor(principal, request));
    return { ok: true };
  }

  // --- subscriptions -------------------------------------------------------

  @Get('subscriptions')
  @ApiOperation({ summary: 'Your subscriptions' })
  async mySubscriptions(@CurrentUser() principal: AuthenticatedPrincipal) {
    return {
      data: await this.subscriptions.listForCustomer(await this.customerId(principal.userId)),
    };
  }

  @Post('subscriptions')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Start a subscription',
    description:
      'Prices come from the catalogue and become the agreed price. The first charge is taken immediately; nothing ships until it settles.',
  })
  async subscribe(
    @Body(zodBody(createSubscriptionSchema)) input: CreateSubscriptionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.subscriptions.create(customerId, input, this.actor(principal, request));
  }

  @Patch('subscriptions/:id')
  @ApiOperation({ summary: 'Change the card or delivery address' })
  async updateSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateSubscriptionSchema)) input: UpdateSubscriptionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.subscriptions.update(id, customerId, input, this.actor(principal, request));
  }

  @Post('subscriptions/:id/pause')
  @ApiOperation({ summary: 'Pause a subscription' })
  async pauseSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(pauseSubscriptionSchema)) input: PauseSubscriptionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.subscriptions.pause(id, customerId, input, this.actor(principal, request));
  }

  @Post('subscriptions/:id/resume')
  @ApiOperation({ summary: 'Resume a paused subscription' })
  async resumeSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.subscriptions.resume(id, customerId, this.actor(principal, request));
  }

  @Post('subscriptions/:id/cancel')
  @ApiOperation({
    summary: 'Cancel a subscription',
    description:
      'Immediate, and needs no reason. There is no retention flow and no waiting period: cancelling must not be harder than subscribing was.',
  })
  async cancelSubscription(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(cancelSubscriptionSchema)) input: CancelSubscriptionInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.subscriptions.cancel(id, customerId, input, this.actor(principal, request));
  }

  // --- support -------------------------------------------------------------

  @Get('support/guidance')
  @ApiOperation({
    summary: 'What this inbox is and is not for',
    description:
      'Shown before the customer types. We cannot answer clinical questions and do not want the details.',
  })
  guidance(): { medicalRedirect: string } {
    return { medicalRedirect: this.support.medicalRedirect };
  }

  @Get('support')
  @ApiOperation({ summary: 'Your conversations' })
  async myThreads(@CurrentUser() principal: AuthenticatedPrincipal) {
    return { data: await this.support.listForCustomer(await this.customerId(principal.userId)) };
  }

  @Get('support/:id')
  @ApiOperation({
    summary: 'One conversation',
    description: 'Internal staff notes are excluded in the query, not filtered out afterwards.',
  })
  async myThread(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
  ) {
    return this.support.findForCustomer(id, await this.customerId(principal.userId));
  }

  @Post('support')
  @RateLimit('sensitive')
  @ApiOperation({ summary: 'Start a conversation' })
  async openThread(
    @Body(zodBody(createSupportThreadSchema)) input: CreateSupportThreadInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.support.open(customerId, input, this.actor(principal, request));
  }

  @Post('support/:id/replies')
  @ApiOperation({ summary: 'Reply to a conversation' })
  async replyToThread(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(supportReplySchema)) input: SupportReplyInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.support.replyAsCustomer(id, customerId, input, this.actor(principal, request));
  }

  // --- preferences, export and erasure -------------------------------------

  @Get('consents')
  @ApiOperation({ summary: 'What you agreed to, and when' })
  async consents(@CurrentUser() principal: AuthenticatedPrincipal) {
    return { data: await this.account.consentHistory(await this.customerId(principal.userId)) };
  }

  @Patch('marketing-preferences')
  @ApiOperation({
    summary: 'Change marketing preferences',
    description:
      'Writes a consent ledger entry. Transactional mail is not on this list: you cannot unsubscribe from being told your order shipped.',
  })
  async setMarketing(
    @Body(zodBody(marketingPreferencesSchema)) input: MarketingPreferencesInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.account.setMarketingPreferences(customerId, input, this.actor(principal, request));
  }

  @Get('export')
  @RateLimit('sensitive')
  @ApiOperation({ summary: 'Everything we hold about you' })
  async exportData(@CurrentUser() principal: AuthenticatedPrincipal, @Req() request: Request) {
    const customerId = await this.customerId(principal.userId);
    return this.account.exportData(customerId, this.actor(principal, request));
  }

  @Get('erasure')
  @ApiOperation({
    summary: 'What deleting your account would and would not remove',
    description: 'Shown before you ask, not after.',
  })
  erasureScope() {
    return this.account.erasureScope();
  }

  @Post('erasure')
  @RateLimit('sensitive')
  @ApiOperation({
    summary: 'Ask for your account to be deleted',
    description:
      'Reviewed by a person. Orders, payments and the record of which lots you received are retained — the last so you can be reached in a recall.',
  })
  async requestErasure(
    @Body(zodBody(requestErasureSchema)) input: RequestErasureInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    const customerId = await this.customerId(principal.userId);
    return this.account.requestErasure(customerId, input, this.actor(principal, request));
  }
}
