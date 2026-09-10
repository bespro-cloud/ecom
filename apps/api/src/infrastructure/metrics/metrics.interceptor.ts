import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, tap, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { MetricsService } from './metrics.service.js';

/** Records request count and latency, including for failed requests. */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const start = process.hrtime.bigint();

    // The route pattern, not the concrete path: keeps label cardinality bounded.
    const route = (request.route as { path?: string } | undefined)?.path ?? 'unmatched';
    const method = request.method;

    const record = (status: number): void => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { method, route, status: String(status) };
      this.metrics.httpRequests.inc(labels);
      this.metrics.httpDuration.observe(labels, seconds);
    };

    return next.handle().pipe(
      tap(() => record(response.statusCode)),
      catchError((error: unknown) => {
        const status =
          typeof (error as { getStatus?: () => number }).getStatus === 'function'
            ? (error as { getStatus: () => number }).getStatus()
            : 500;
        record(status);
        return throwError(() => error);
      }),
    );
  }
}
