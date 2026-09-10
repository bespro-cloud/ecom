import type { Request } from 'express';
import { truncateIp } from '@health/config';
import { CORRELATION_ID_HEADER } from './middleware/correlation-id.middleware.js';

export interface RequestAuditContext {
  correlationId: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Extracts the metadata every audit record carries.
 *
 * The client IP is truncated before it leaves this function, so nothing
 * downstream can accidentally persist a full address.
 */
export function requestContextFrom(request: Request): RequestAuditContext {
  return {
    correlationId: (request.headers[CORRELATION_ID_HEADER] as string) ?? 'unknown',
    ipAddress: truncateIp(request.ip ?? request.socket?.remoteAddress ?? null),
    userAgent: request.headers['user-agent']?.slice(0, 512) ?? null,
  };
}
