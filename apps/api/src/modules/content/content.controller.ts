import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import {
  createPageSchema,
  seoMetadataSchema,
  slugSchema,
  updatePageSchema,
  uuidSchema,
} from '@health/validation';
import type { CreatePageInput, SeoMetadataInput, UpdatePageInput } from '@health/validation';
import type { AuthenticatedPrincipal } from '@health/types';
import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermissions } from '../../common/decorators/permissions.decorator.js';
import { zodBody, ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { requestContextFrom } from '../../common/request-context.js';
import { PagesService, type PageView } from './pages.service.js';
import { SeoService, type SeoEntityType, type SeoView } from './seo.service.js';

const unpublishSchema = z.object({
  reason: z.string().trim().min(5, 'Record why this page is being taken down.').max(500),
});

const seoEntitySchema = z.enum(['PRODUCT', 'CATEGORY', 'PAGE', 'INGREDIENT']);

@ApiTags('Content')
@Controller({ path: 'content', version: '1' })
export class ContentController {
  constructor(
    private readonly pages: PagesService,
    private readonly seo: SeoService,
  ) {}

  private actor(principal: AuthenticatedPrincipal, request: Request) {
    return {
      actorId: principal.userId,
      actorLabel: principal.email,
      ...requestContextFrom(request),
    };
  }

  // --- public --------------------------------------------------------------

  @Get('pages/:slug')
  @Public()
  @ApiOperation({
    summary: 'Fetch a published page',
    description: 'Returns the live version only; unpublished drafts are not reachable here.',
  })
  async findPublished(@Param('slug', new ZodValidationPipe(slugSchema)) slug: string) {
    return this.pages.findPublishedBySlug(slug);
  }

  @Get('sitemap')
  @Public()
  @ApiOperation({ summary: 'Indexable page URLs' })
  async sitemap(): Promise<{ pages: Array<{ slug: string; updatedAt: string }> }> {
    return { pages: await this.pages.listPublishedForSitemap() };
  }

  // --- administration ------------------------------------------------------

  @Get('admin/pages')
  @RequirePermissions('CONTENT_READ')
  @ApiOperation({ summary: 'List pages, including drafts' })
  async list(): Promise<{ data: PageView[] }> {
    return { data: await this.pages.list() };
  }

  @Get('admin/pages/:id')
  @RequirePermissions('CONTENT_READ')
  @ApiOperation({ summary: 'Fetch a page with its unpublished draft' })
  async findOne(@Param('id', new ZodValidationPipe(uuidSchema)) id: string): Promise<PageView> {
    return this.pages.findById(id);
  }

  @Post('admin/pages')
  @RequirePermissions('CONTENT_WRITE')
  @ApiOperation({ summary: 'Create a page' })
  async create(
    @Body(zodBody(createPageSchema)) input: CreatePageInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<PageView> {
    return this.pages.create(input, this.actor(principal, request));
  }

  @Patch('admin/pages/:id')
  @RequirePermissions('CONTENT_WRITE')
  @ApiOperation({
    summary: 'Save an edit',
    description:
      'On a live page the edit is saved as a draft, so what visitors see does not change until it is published.',
  })
  async update(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(updatePageSchema)) input: UpdatePageInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<PageView> {
    return this.pages.update(id, input, this.actor(principal, request));
  }

  @Post('admin/pages/:id/publish')
  @RequirePermissions('CONTENT_PUBLISH')
  @ApiOperation({ summary: 'Publish the current draft' })
  async publish(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<PageView> {
    return this.pages.publish(id, this.actor(principal, request));
  }

  @Post('admin/pages/:id/unpublish')
  @RequirePermissions('CONTENT_PUBLISH')
  @ApiOperation({ summary: 'Take a page down' })
  async unpublish(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @Body(zodBody(unpublishSchema)) input: z.infer<typeof unpublishSchema>,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<PageView> {
    return this.pages.unpublish(id, input.reason, this.actor(principal, request));
  }

  @Delete('admin/pages/:id')
  @RequirePermissions('CONTENT_WRITE')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete an unpublished page' })
  async remove(
    @Param('id', new ZodValidationPipe(uuidSchema)) id: string,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<void> {
    await this.pages.remove(id, this.actor(principal, request));
  }

  // --- SEO -----------------------------------------------------------------

  @Get('admin/seo/:entityType/:entityId')
  @RequirePermissions('SEO_READ')
  @ApiOperation({ summary: 'Fetch SEO metadata for an entity' })
  async getSeo(
    @Param('entityType', new ZodValidationPipe(seoEntitySchema)) entityType: SeoEntityType,
    @Param('entityId', new ZodValidationPipe(uuidSchema)) entityId: string,
  ): Promise<SeoView | null> {
    return this.seo.get(entityType, entityId);
  }

  @Put('admin/seo/:entityType/:entityId')
  @RequirePermissions('SEO_WRITE')
  @ApiOperation({
    summary: 'Set SEO metadata',
    description:
      'Copy is written by a person. Nothing here generates a description — a meta description is a public statement about a health product.',
  })
  async setSeo(
    @Param('entityType', new ZodValidationPipe(seoEntitySchema)) entityType: SeoEntityType,
    @Param('entityId', new ZodValidationPipe(uuidSchema)) entityId: string,
    @Body(zodBody(seoMetadataSchema)) input: SeoMetadataInput,
    @CurrentUser() principal: AuthenticatedPrincipal,
    @Req() request: Request,
  ): Promise<SeoView> {
    return this.seo.upsert(entityType, entityId, input, this.actor(principal, request));
  }
}
