import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CartService } from './cart/cart.service.js';
import { CartController } from './cart/cart.controller.js';
import { CheckoutService } from './checkout/checkout.service.js';
import { CheckoutController } from './checkout/checkout.controller.js';
import { InventoryService } from './inventory/inventory.service.js';
import { WarehousesService } from './inventory/warehouses.service.js';
import { OrdersService } from './orders/orders.service.js';
import { OrdersController } from './orders/orders.controller.js';
import { PaymentsService } from './payments/payments.service.js';
import { paymentProviderFactory } from './payments/payment.provider.js';
import { PaymentWebhooksController } from './payments/webhooks.controller.js';
import { RefundsService } from './refunds/refunds.service.js';
import { ShippingService } from './shipping/shipping.service.js';
import { CommerceAdminController } from './commerce.controller.js';
import { CouponsService } from '../lifecycle/coupons/coupons.service.js';
import { GrowthModule } from '../growth/growth.module.js';

/**
 * Commerce: carts, checkout, orders, payments, refunds, inventory, shipping.
 *
 * `WarehousesService` and `InventoryService` are exported because the catalogue
 * module's publishing checklist needs them — a product cannot be published
 * unless the warehouse could actually fill an order for it.
 */
@Module({
  imports: [GrowthModule, AuditModule, SettingsModule],
  controllers: [
    CartController,
    CheckoutController,
    OrdersController,
    PaymentWebhooksController,
    CommerceAdminController,
  ],
  providers: [
    paymentProviderFactory,
    CartService,
    CheckoutService,
    InventoryService,
    WarehousesService,
    OrdersService,
    PaymentsService,
    RefundsService,
    ShippingService,
    // Checkout prices a discount code through the same evaluation the admin
    // console reads. Provided here rather than imported from the lifecycle
    // module, which imports this one — the dependency runs one way.
    CouponsService,
  ],
  exports: [
    InventoryService,
    WarehousesService,
    OrdersService,
    CartService,
    ShippingService,
    CouponsService,
    paymentProviderFactory,
  ],
})
export class CommerceModule {}
