import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import * as Sentry from '@sentry/node';
import { EnvValidationError, parseServerEnv } from '@health/config';
import { WorkerModule } from './app.module.js';

/**
 * Worker entrypoint.
 *
 * It is an HTTP application only so that health endpoints exist; it serves no
 * business traffic. The port is bound to loopback-visible 0.0.0.0 inside the
 * container network and is never exposed publicly (see the nginx config).
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
      sendDefaultPii: false,
      initialScope: { tags: { service: 'worker' } },
    });
  }

  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Lets BullMQ finish in-flight jobs and the outbox loop settle before exit.
  app.enableShutdownHooks();

  await app.listen(env.WORKER_PORT, '0.0.0.0');
  console.warn(`[worker] listening on port ${env.WORKER_PORT} (${env.NODE_ENV})`);
}

bootstrap().catch((error: unknown) => {
  console.error('[worker] failed to start', error);
  process.exit(1);
});
