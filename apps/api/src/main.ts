import 'reflect-metadata';
import * as Sentry from '@sentry/node';
import { parseServerEnv, EnvValidationError } from '@health/config';
import { createApp, configureOpenApi } from './bootstrap.js';
import { AppConfigService } from './infrastructure/config/app-config.service.js';

/**
 * Server entrypoint.
 *
 * Configuration is validated before anything else starts, so a
 * misconfiguration is a fast, loud boot failure rather than a subtle runtime
 * problem discovered by a customer.
 */
async function bootstrap(): Promise<void> {
  let env;
  try {
    env = parseServerEnv();
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      // Belt and braces: the log redactor already strips these, but Sentry
      // captures request data through a different path.
      sendDefaultPii: false,
    });
  }

  const app = await createApp();
  const config = app.get(AppConfigService);

  // The interactive docs describe every endpoint including the auth flows; they
  // are not published in production.
  if (!config.isProduction) {
    configureOpenApi(app);
  }

  await app.listen(config.env.API_PORT, '0.0.0.0');

  const logger = app.get(AppConfigService);
  console.warn(
    `[api] listening on port ${logger.env.API_PORT} (${logger.env.NODE_ENV})` +
      (config.isProduction ? '' : ` — docs at ${logger.env.API_PUBLIC_URL}/api/docs`),
  );
}

bootstrap().catch((error: unknown) => {
  console.error('[api] failed to start', error);
  process.exit(1);
});
