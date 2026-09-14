import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  analyticsBeaconSchema,
  resolveRedirectSchema,
  slugSchema,
  type AnalyticsBeaconInput,
  type ResolveRedirectInput,
} from '@health/validation';
import { Public } from '../../common/decorators/public.decorator.js';
import { RateLimit } from '../../common/decorators/rate-limit.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { AnalyticsCollectionService } from './analytics/collection.service.js';
import { BlogService } from './blog/blog.service.js';
import { RedirectsService } from './redirects/redirects.service.js';

/**
 * The public surface of the growth module: the analytics beacon, the blog, and
 * redirect resolution for the storefront's middleware.
 */
@ApiTags('Growth')
@Controller({ version: '1' })
export class GrowthPublicController {
  constructor(
    private readonly collection: AnalyticsCollectionService,
    private readonly blog: BlogService,
    private readonly redirects: RedirectsService,
  ) {}

  // --- analytics -----------------------------------------------------------

  /**
   * The analytics beacon.
   *
   * Always answers `202 Accepted` with an empty body, whether or not anything
   * was recorded. Reporting the refusal would turn this into an oracle for
   * probing which visitors are being measured, and there is nothing the browser
   * would do differently with the answer.
   *
   * Rate-limited like a sensitive endpoint despite being public and
   * unauthenticated, because it writes rows and is the obvious thing to point a
   * script at.
   */
  @Post('analytics/collect')
  @Public()
  @RateLimit('sensitive')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Report browsing events',
    description:
      'First-party only. Refuses Do Not Track and Global Privacy Control regardless of the consent flag in the body, discards every query string before storing a path, and cannot accept a purchase event — conversions are recorded server-side from real orders.',
  })
  async collect(
    @Body(zodBody(analyticsBeaconSchema)) input: AnalyticsBeaconInput,
    @Req() request: Request,
  ): Promise<void> {
    await this.collection.collect(input, {
      // Used to derive a salted daily hash inside the service and never stored.
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
      doNotTrackHeader: request.get('dnt') ?? null,
      globalPrivacyControlHeader: request.get('sec-gpc') ?? null,
      // Country only, when an edge sets one. A city on a health site is a small
      // crowd.
      country: request.get('cf-ipcountry') ?? request.get('x-vercel-ip-country') ?? null,
    });
  }

  // --- blog ----------------------------------------------------------------

  @Get('blog/posts')
  @Public()
  @ApiOperation({ summary: 'Published blog posts, newest first' })
  async posts(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    const parsed = Number(limit);
    const take = Number.isInteger(parsed) && parsed > 0 && parsed <= 50 ? parsed : 20;
    return this.blog.listPublished(take, cursor);
  }

  @Get('blog/posts/:slug')
  @Public()
  @ApiOperation({
    summary: 'One published post',
    description:
      'Linked products are resolved to published listings only. A post approved while a product was live must not keep linking to it after it was withdrawn.',
  })
  async post(@Param('slug', new ZodValidationPipe(slugSchema)) slug: string) {
    return this.blog.findPublishedBySlug(slug);
  }

  @Get('blog/categories')
  @Public()
  @ApiOperation({ summary: 'Blog categories' })
  async categories() {
    return { data: await this.blog.listCategories() };
  }

  // --- redirects -----------------------------------------------------------

  /**
   * Resolves a path for the storefront's middleware.
   *
   * Public because the middleware runs before any session exists, and because
   * the answer — "this old URL moved here" — is something the redirect would
   * tell any visitor anyway.
   */
  @Post('redirects/resolve')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve a path to its redirect target, if it has one',
    description:
      'Follows chains to the final destination so a visitor makes one hop, and refuses to answer at all if it detects a cycle.',
  })
  async resolve(
    @Body(zodBody(resolveRedirectSchema)) input: ResolveRedirectInput,
  ): Promise<{ redirect: { toPath: string; statusCode: number } | null }> {
    return { redirect: await this.redirects.resolve(input.path) };
  }
}
