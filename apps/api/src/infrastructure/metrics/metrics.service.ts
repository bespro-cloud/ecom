import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Histogram, Registry, type Metric } from 'prom-client';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Prometheus metrics.
 *
 * Deliberately low-cardinality: paths are recorded as the matched *route*
 * (`/api/v1/users/:id`), never the concrete URL, so an id in a path cannot
 * explode the series count.
 */
@Injectable()
export class MetricsService implements OnModuleDestroy {
  readonly registry = new Registry();
  private readonly defaultMetricsTimer: ReturnType<typeof collectDefaultMetrics> | null = null;

  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  readonly authEvents: Counter<'event' | 'outcome'>;
  readonly auditWrites: Counter<'action' | 'outcome'>;

  constructor(config: AppConfigService) {
    this.registry.setDefaultLabels({ service: 'api', env: config.env.NODE_ENV });
    if (config.env.METRICS_ENABLED) {
      // Keeps a timer alive; cleared on shutdown so the process can exit.
      this.defaultMetricsTimer = collectDefaultMetrics({ register: this.registry });
    }

    this.httpRequests = this.register(
      new Counter({
        name: 'http_requests_total',
        help: 'Total HTTP requests handled.',
        labelNames: ['method', 'route', 'status'] as const,
      }),
    );

    this.httpDuration = this.register(
      new Histogram({
        name: 'http_request_duration_seconds',
        help: 'HTTP request duration in seconds.',
        labelNames: ['method', 'route', 'status'] as const,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      }),
    );

    this.authEvents = this.register(
      new Counter({
        name: 'auth_events_total',
        help: 'Authentication events by type and outcome.',
        labelNames: ['event', 'outcome'] as const,
      }),
    );

    this.auditWrites = this.register(
      new Counter({
        name: 'audit_writes_total',
        help: 'Audit records written, by action and outcome.',
        labelNames: ['action', 'outcome'] as const,
      }),
    );
  }

  private register<T extends Metric>(metric: T): T {
    this.registry.registerMetric(metric);
    return metric;
  }

  async scrape(): Promise<string> {
    return this.registry.metrics();
  }

  onModuleDestroy(): void {
    if (this.defaultMetricsTimer) clearInterval(this.defaultMetricsTimer as NodeJS.Timeout);
    this.registry.clear();
  }
}
