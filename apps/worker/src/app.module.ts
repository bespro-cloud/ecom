import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { LOG_REDACT_PATHS, parseServerEnv } from '@health/config';
import { ClockModule } from './clock.module.js';
import { PrismaService } from './prisma.service.js';
import { WorkerMetricsService } from './metrics.service.js';
import { QueueService } from './queues/queue.service.js';
import { OutboxDispatcherService } from './outbox/outbox-dispatcher.service.js';
import { EmailProcessor } from './processors/email.processor.js';
import { MaintenanceService } from './processors/maintenance.service.js';
import { WorkerHealthController } from './health/health.controller.js';

@Module({
  imports: [
    LoggerModule.forRootAsync({
      useFactory: () => {
        const env = parseServerEnv();
        return {
          pinoHttp: {
            level: env.LOG_LEVEL,
            customProps: () => ({ service: 'worker' }),
            redact: { paths: [...LOG_REDACT_PATHS], censor: '[Redacted]' },
            autoLogging: false,
            transport: env.LOG_PRETTY
              ? { target: 'pino-pretty', options: { singleLine: true, colorize: true } }
              : undefined,
          },
        };
      },
    }),
    ScheduleModule.forRoot(),
    ClockModule,
  ],
  controllers: [WorkerHealthController],
  providers: [
    PrismaService,
    WorkerMetricsService,
    QueueService,
    OutboxDispatcherService,
    EmailProcessor,
    MaintenanceService,
  ],
})
export class WorkerModule {}
