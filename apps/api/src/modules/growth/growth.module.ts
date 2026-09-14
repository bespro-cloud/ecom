import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { MediaModule } from '../media/media.module.js';
import { AnalyticsCollectionService } from './analytics/collection.service.js';
import { AnalyticsReportingService } from './analytics/reporting.service.js';
import { BlogService } from './blog/blog.service.js';
import { RedirectsService } from './redirects/redirects.service.js';
import { SeoAuditService } from './seo/seo-audit.service.js';
import { GrowthPublicController } from './growth.controller.js';
import { GrowthAdminController } from './growth-admin.controller.js';

/**
 * Growth: analytics, the blog, redirects and the SEO audit.
 *
 * `RedirectsService` is exported because the catalogue and content modules need
 * it: renaming a product or a page must write the redirect that keeps its
 * indexed URL working, inside the same transaction as the rename.
 *
 * `AnalyticsCollectionService` is exported so the commerce module can record a
 * conversion from a real order. That direction matters — analytics reaches into
 * commerce for nothing at all, and commerce hands analytics a session id and no
 * more.
 */
@Module({
  imports: [AuditModule, MediaModule],
  controllers: [GrowthPublicController, GrowthAdminController],
  providers: [
    AnalyticsCollectionService,
    AnalyticsReportingService,
    BlogService,
    RedirectsService,
    SeoAuditService,
  ],
  exports: [AnalyticsCollectionService, RedirectsService, BlogService],
})
export class GrowthModule {}
