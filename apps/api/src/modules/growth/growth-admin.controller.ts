import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  analyticsRangeSchema,
  blogQuerySchema,
  createBlogCategorySchema,
  createBlogPostSchema,
  createRedirectSchema,
  redirectQuerySchema,
  reviewBlogPostSchema,
  updateBlogPostSchema,
  updateRedirectSchema,
  uuidSchema,
  type AnalyticsRangeInput,
  type BlogQuery,
  type CreateBlogCategoryInput,
  type CreateBlogPostInput,
  type CreateRedirectInput,
  type RedirectQuery,
  type ReviewBlogPostInput,
  type UpdateBlogPostInput,
  type UpdateRedirectInput,
} from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireMfa, RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { AnalyticsReportingService } from './analytics/reporting.service.js';
import { BlogService } from './blog/blog.service.js';
import { RedirectsService } from './redirects/redirects.service.js';
import { SeoAuditService } from './seo/seo-audit.service.js';

/**
 * Growth administration.
 *
 * Two permission choices carry the weight of this module.
 *
 * **Approving a blog post is `COMPLIANCE_APPROVE`, not `BLOG_PUBLISH`.** A post
 * that names a product is marketing copy about a regulated product, so signing
 * it off is the same authority that signs off a product compliance review — and
 * that permission is held by compliance reviewers and deliberately not by
 * `ADMIN`, a content manager, or the person who wrote the post. A writer who
 * could approve their own copy is not a gate, it is a formality. It requires a
 * second factor for the same reason a claim approval does.
 *
 * **Reading analytics is `ANALYTICS_READ` over rollups only.** There is no
 * endpoint anywhere that returns raw events, and none that takes a customer id,
 * because there is no query about an individual that this system can answer.
 */
@ApiTags('Growth')
@Controller({ path: 'admin/growth', version: '1' })
export class GrowthAdminController {
  constructor(
    private readonly reporting: AnalyticsReportingService,
    private readonly blog: BlogService,
    private readonly redirects: RedirectsService,
    private readonly seoAudit: SeoAuditService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  private range(input?: AnalyticsRangeInput): AnalyticsRangeInput {
    return input ?? this.reporting.defaultRange();
  }

  // --- analytics -----------------------------------------------------------

  @Get('analytics/overview')
  @RequirePermissions('ANALYTICS_READ')
  @ApiOperation({
    summary: 'Traffic, funnel and revenue for a date range',
    description:
      'Sessions and views come from the analytics rollups; orders and revenue come from the orders table. The two are joined on a day and a channel label, never on anything that identifies a person.',
  })
  async overview(@Query(zodBody(analyticsRangeSchema.optional())) range?: AnalyticsRangeInput) {
    return this.reporting.overview(this.range(range));
  }

  @Get('analytics/channels')
  @RequirePermissions('ANALYTICS_READ')
  @ApiOperation({ summary: 'Sessions, orders and revenue by acquisition channel' })
  async channels(@Query(zodBody(analyticsRangeSchema.optional())) range?: AnalyticsRangeInput) {
    return { data: await this.reporting.channels(this.range(range)) };
  }

  @Get('analytics/products')
  @RequirePermissions('ANALYTICS_READ')
  @ApiOperation({
    summary: 'Views, add-to-carts, units and revenue by product',
    description: 'Counts of events, never a list of who. Units and money come from order items.',
  })
  async products(@Query(zodBody(analyticsRangeSchema.optional())) range?: AnalyticsRangeInput) {
    return { data: await this.reporting.products(this.range(range)) };
  }

  // --- blog ----------------------------------------------------------------

  @Get('blog/posts')
  @RequirePermissions('BLOG_READ')
  @ApiOperation({ summary: 'Posts in every state' })
  async listPosts(@Query(zodBody(blogQuerySchema)) query: BlogQuery) {
    return this.blog.list(query);
  }

  @Get('blog/posts/:id')
  @RequirePermissions('BLOG_READ')
  @ApiOperation({
    summary: 'One post, with its compliance history',
    description:
      'Carries `claimPromptTerms`: wording that often signals a health claim, surfaced for the reviewer. Advisory only — nothing in the system acts on it.',
  })
  async findPost(@Param('id', new ZodValidationPipe(uuidSchema)) id: string) {
    return this.blog.findById(id);
  }

  @Post('blog/posts')
  @RequirePermissions('BLOG_WRITE')
  @ApiOperation({ summary: 'Draft a post' })
  async createPost(
    @Body(zodBody(createBlogPostSchema)) input: CreateBlogPostInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.create(input, this.actor(principal, request));
  }

  @Patch('blog/posts/:id')
  @RequirePermissions('BLOG_WRITE')
  @ApiOperation({
    summary: 'Edit a post',
    description:
      'Editing a live post writes to the draft, so readers keep seeing the approved text. Any edit to the title, body or product list clears an existing compliance approval — the approval was of a specific text.',
  })
  async updatePost(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateBlogPostSchema)) input: UpdateBlogPostInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.update(id, input, this.actor(principal, request));
  }

  @Post('blog/posts/:id/submit')
  @RequirePermissions('BLOG_WRITE')
  @ApiOperation({
    summary: 'Send a post to compliance',
    description: 'Only for a post that names a product. One that names none has nothing to decide.',
  })
  async submitPost(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.submitForReview(id, this.actor(principal, request));
  }

  /**
   * The gate.
   *
   * `COMPLIANCE_APPROVE` and MFA — the same bar as approving a product claim,
   * because it is the same kind of decision about the same kind of statement.
   */
  @Post('blog/posts/:id/review')
  @RequirePermissions('COMPLIANCE_APPROVE')
  @RequireMfa()
  @ApiOperation({
    summary: 'Approve or reject a post that names a product',
    description:
      'Held by compliance reviewers, not by content or marketing staff and not by ADMIN: a writer who could approve their own copy is not a gate. Written reasoning is required on either outcome, and the reviewed text is snapshotted into the decision so "what did they approve?" is answerable after fifty edits.',
  })
  async reviewPost(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(reviewBlogPostSchema)) input: ReviewBlogPostInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.review(id, input, this.actor(principal, request));
  }

  @Post('blog/posts/:id/publish')
  @RequirePermissions('BLOG_PUBLISH')
  @ApiOperation({
    summary: 'Publish a post',
    description:
      'Refused for a post that names a product and has no live compliance approval. A database CHECK refuses it too, so no code path can put unreviewed product claims on a public page.',
  })
  async publishPost(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.publish(id, this.actor(principal, request));
  }

  @Post('blog/posts/:id/unpublish')
  @RequirePermissions('BLOG_PUBLISH')
  @ApiOperation({ summary: 'Take a post off the site' })
  async unpublishPost(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.unpublish(id, this.actor(principal, request));
  }

  @Post('blog/categories')
  @RequirePermissions('BLOG_WRITE')
  @ApiOperation({ summary: 'Create a blog category' })
  async createCategory(
    @Body(zodBody(createBlogCategorySchema)) input: CreateBlogCategoryInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.blog.createCategory(input, this.actor(principal, request));
  }

  // --- redirects -----------------------------------------------------------

  @Get('redirects')
  @RequirePermissions('SEO_READ')
  @ApiOperation({ summary: 'Redirects, most-used first' })
  async listRedirects(@Query(zodBody(redirectQuerySchema)) query: RedirectQuery) {
    return this.redirects.list(query);
  }

  @Post('redirects')
  @RequirePermissions('SEO_WRITE')
  @ApiOperation({
    summary: 'Create a redirect',
    description: 'Refuses a rule that would close a loop, at any chain length.',
  })
  async createRedirect(
    @Body(zodBody(createRedirectSchema)) input: CreateRedirectInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.redirects.create(input, this.actor(principal, request));
  }

  @Patch('redirects/:id')
  @RequirePermissions('SEO_WRITE')
  @ApiOperation({ summary: 'Edit or switch off a redirect' })
  async updateRedirect(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updateRedirectSchema)) input: UpdateRedirectInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ) {
    return this.redirects.update(id, input, this.actor(principal, request));
  }

  @Delete('redirects/:id')
  @RequirePermissions('SEO_WRITE')
  @ApiOperation({
    summary: 'Delete a redirect',
    description:
      'The old URL starts returning 404 again. Usually switching it off is what you want.',
  })
  async deleteRedirect(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<{ ok: true }> {
    await this.redirects.remove(id, this.actor(principal, request));
    return { ok: true };
  }

  // --- SEO -----------------------------------------------------------------

  @Get('seo/audit')
  @RequirePermissions('SEO_READ')
  @ApiOperation({
    summary: 'Report SEO problems across published content',
    description:
      'Reports only. Nothing here generates a title, a description or alt text: a meta description for a supplement is a public statement about a health product, and a generated one is exactly the plausible sentence that ends up claiming something nobody reviewed.',
  })
  async audit() {
    return this.seoAudit.run();
  }
}
