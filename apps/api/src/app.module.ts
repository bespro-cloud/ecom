import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from './infrastructure/logger/logger.module.js';
import { AppConfigModule } from './infrastructure/config/config.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { RedisModule } from './infrastructure/redis/redis.module.js';
import { MetricsModule } from './infrastructure/metrics/metrics.module.js';
import { MetricsInterceptor } from './infrastructure/metrics/metrics.interceptor.js';
import { OutboxModule } from './infrastructure/outbox/outbox.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { RbacModule } from './modules/rbac/rbac.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { SettingsModule } from './modules/settings/settings.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { CorrelationIdMiddleware } from './common/middleware/correlation-id.middleware.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { CsrfGuard } from './common/guards/csrf.guard.js';
import { RateLimitGuard } from './common/guards/rate-limit.guard.js';

/**
 * Guard order matters and is fixed here:
 *   RateLimit → CSRF → JwtAuth → Permissions
 *
 * Rate limiting runs before anything expensive; CSRF is checked before we do
 * any work on a state-changing request; authentication establishes the
 * principal; authorisation then decides. Nest applies APP_GUARD providers in
 * registration order.
 *
 * Note that the rate limiter therefore buckets unauthenticated requests by
 * source address — the principal is not known yet at that point — which is the
 * correct behaviour for the endpoints that need protecting most (sign-in).
 */
@Module({
  imports: [
    LoggerModule,
    AppConfigModule,
    PrismaModule,
    RedisModule,
    MetricsModule,
    OutboxModule,
    AuditModule,
    RbacModule,
    AuthModule,
    UsersModule,
    CustomersModule,
    SettingsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
