import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CommerceModule } from '../commerce/commerce.module.js';
import { ReviewsService } from './reviews/reviews.service.js';
import { SubscriptionsService } from './subscriptions/subscriptions.service.js';
import { SupportService } from './support/support.service.js';
import { AccountService } from './account/account.service.js';
import { AccountLifecycleController } from './lifecycle.controller.js';
import { LifecycleAdminController } from './lifecycle-admin.controller.js';
import { PublicReviewsController } from './reviews.public.controller.js';

/**
 * The customer lifecycle.
 *
 * `ReviewsService` and `CouponsService` are exported because the catalogue and
 * commerce modules need them: a product page shows its published reviews, and
 * checkout prices a discount code through the same evaluation the admin console
 * reads.
 */
@Module({
  imports: [AuditModule, SettingsModule, CommerceModule],
  controllers: [AccountLifecycleController, LifecycleAdminController, PublicReviewsController],
  // `CouponsService` is provided by the commerce module and imported here, not
  // declared again: two instances of a service that enforces a redemption limit
  // is exactly the kind of thing that works until it does not.
  providers: [ReviewsService, SubscriptionsService, SupportService, AccountService],
  exports: [ReviewsService, SubscriptionsService],
})
export class LifecycleModule {}
