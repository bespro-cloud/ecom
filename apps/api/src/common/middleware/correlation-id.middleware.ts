import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Assigns a correlation id to every request and echoes it back.
 *
 * An inbound id is honoured only when it is a well-formed UUID, so a client
 * cannot inject arbitrary text into log lines (or forge another request's id).
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.headers[CORRELATION_ID_HEADER];
    const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
    const correlationId = candidate && UUID_PATTERN.test(candidate) ? candidate : randomUUID();

    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    next();
  }
}
