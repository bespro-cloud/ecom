import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { LOG_REDACT_PATHS, parseServerEnv } from '@health/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_ID_HEADER } from '../../common/middleware/correlation-id.middleware.js';

/**
 * Structured JSON logging.
 *
 * Every line carries the correlation id, so a single request can be followed
 * across the API, the worker and Sentry. Redaction is configured at the
 * transport level rather than at call sites — a developer cannot forget it.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      useFactory: () => {
        const env = parseServerEnv();
        return {
          pinoHttp: {
            level: env.LOG_LEVEL,
            genReqId: (req: IncomingMessage) =>
              (req.headers[CORRELATION_ID_HEADER] as string) ?? randomUUID(),
            customProps: (req: IncomingMessage) => ({
              correlationId: req.headers[CORRELATION_ID_HEADER],
              service: 'api',
            }),
            redact: { paths: [...LOG_REDACT_PATHS], censor: '[Redacted]' },
            autoLogging: {
              // Health checks would otherwise dominate the log volume.
              ignore: (req: IncomingMessage) => (req.url ?? '').startsWith('/health'),
            },
            serializers: {
              req: (req: { method: string; url: string; id: string }) => ({
                id: req.id,
                method: req.method,
                // Query strings can carry tokens from a mis-built client link.
                url: (req.url ?? '').split('?')[0],
              }),
              res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
            },
            transport: env.LOG_PRETTY
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
