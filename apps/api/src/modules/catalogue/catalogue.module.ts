import { Module } from '@nestjs/common';
import { ReviewsService } from '../lifecycle/reviews/reviews.service.js';
import { MediaModule } from '../media/media.module.js';
import { CommerceModule } from '../commerce/commerce.module.js';
import { ProductsService } from './products/products.service.js';
import { CatalogueService } from './products/catalogue.service.js';
import { CategoriesService } from './categories/categories.service.js';
import { IngredientsService } from './ingredients/ingredients.service.js';
import { PublishChecklistService } from './publishing/publish-checklist.service.js';
import { PostgresSearchProvider } from './search/postgres-search.provider.js';
import { SEARCH_PROVIDER } from './search/search.types.js';
import { CatalogueController } from './catalogue.controller.js';
import { AdminCatalogueController } from './admin-catalogue.controller.js';
import { GrowthModule } from '../growth/growth.module.js';

/**
 * The catalogue.
 *
 * The search provider is bound to a token rather than injected as a concrete
 * class, so swapping PostgreSQL for OpenSearch later is a change to this one
 * line rather than to every call site.
 */
@Module({
  // CommerceModule for the publishing checklist's inventory check: a product
  // cannot be published unless the warehouse could actually fill an order.
  imports: [GrowthModule, MediaModule, CommerceModule],
  controllers: [CatalogueController, AdminCatalogueController],
  providers: [
    // The product page shows its published reviews. Provided here rather
    // than imported from the lifecycle module, which imports commerce, which
    // imports this — the dependency runs one way.
    ReviewsService,
    ProductsService,
    CatalogueService,
    CategoriesService,
    IngredientsService,
    PublishChecklistService,
    PostgresSearchProvider,
    { provide: SEARCH_PROVIDER, useExisting: PostgresSearchProvider },
  ],
  exports: [
    ProductsService,
    CatalogueService,
    CategoriesService,
    IngredientsService,
    PublishChecklistService,
    SEARCH_PROVIDER,
  ],
})
export class CatalogueModule {}
