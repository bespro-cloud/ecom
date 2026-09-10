import { type INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { AppConfigService } from './infrastructure/config/app-config.service.js';

/**
 * Application wiring shared by the server entrypoint and the integration test
 * harness, so tests exercise the same middleware stack that runs in
 * production.
 */
export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    // Errors are rendered by AllExceptionsFilter; Nest's default renderer would
    // leak internals.
    abortOnError: false,
  });

  app.useLogger(app.get(Logger));
  const config = app.get(AppConfigService);

  // Trust the reverse proxy so req.ip is the real client and secure cookies
  // are recognised behind TLS termination.
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      // The API serves JSON only; a strict referrer policy costs nothing.
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.isProduction
        ? { maxAge: 63072000, includeSubDomains: true, preload: true }
        : false,
    }),
  );
  app.use(compression());
  app.use(cookieParser());

  app.enableCors({
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id'],
    maxAge: 600,
  });

  app.setGlobalPrefix('api', {
    exclude: ['health', 'health/live', 'health/ready', 'health/metrics'],
  });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // A 1 MB JSON limit is generous for this API and stops a trivial memory DoS.
  app.useBodyParser('json', { limit: '1mb' });
  app.useBodyParser('urlencoded', { limit: '1mb', extended: true });

  app.enableShutdownHooks();
  return app;
}

export function configureOpenApi(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Health Commerce API')
      .setDescription(
        'US healthcare and wellness commerce platform. All endpoints require authentication unless explicitly marked public.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
      .addCookieAuth('hc_access', { type: 'apiKey', in: 'cookie', name: 'hc_access' })
      .addTag('Health', 'Liveness, readiness and metrics')
      .addTag('Authentication', 'Sign-in, sessions, MFA and credentials')
      .addTag('Users', 'Staff account administration')
      .addTag('Roles', 'Role and permission administration')
      .addTag('Customer account', 'Customer self-service')
      .addTag('System settings', 'Configuration and feature flags')
      .addTag('Audit', 'The append-only audit trail')
      .build(),
    { operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}` },
  );

  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, tagsSorter: 'alpha' },
    customSiteTitle: 'Health Commerce API',
  });
}
