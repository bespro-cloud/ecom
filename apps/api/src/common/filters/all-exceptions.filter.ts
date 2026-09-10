import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Request, Response } from 'express';
import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@health/types';
import { Prisma } from '@health/database';
import { AppException } from '../errors/app-exception.js';
import { CORRELATION_ID_HEADER } from '../middleware/correlation-id.middleware.js';

/**
 * Centralised error handling.
 *
 * Every response leaving the API has the same shape and never carries internal
 * detail. Unrecognised errors become a generic 500 with a correlation id that
 * ties the user-visible message to the full stack trace in the logs.
 */
@Catch()
@Injectable()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const correlationId = (request.headers[CORRELATION_ID_HEADER] as string) ?? 'unknown';

    const mapped = this.map(exception);

    const logPayload = {
      correlationId,
      code: mapped.code,
      status: mapped.status,
      method: request.method,
      path: request.originalUrl ?? request.url,
      internalDetail: mapped.internalDetail,
    };

    if (mapped.status >= 500) {
      this.logger.error({ ...logPayload, err: exception }, mapped.logMessage);
    } else if (
      mapped.status === HttpStatus.UNAUTHORIZED ||
      mapped.status === HttpStatus.FORBIDDEN
    ) {
      // Security-relevant but expected. Logged at warn so it is greppable
      // without drowning the error channel.
      this.logger.warn(logPayload, mapped.logMessage);
    } else {
      this.logger.info(logPayload, mapped.logMessage);
    }

    const body: ApiErrorBody = {
      error: {
        code: mapped.code,
        message: mapped.message,
        correlationId,
        ...(mapped.details ? { details: mapped.details } : {}),
      },
    };

    response.setHeader(CORRELATION_ID_HEADER, correlationId);
    if (mapped.status === HttpStatus.TOO_MANY_REQUESTS && mapped.retryAfterSeconds) {
      response.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    response.status(mapped.status).json(body);
  }

  private map(exception: unknown): {
    status: number;
    code: ErrorCode;
    message: string;
    details?: Array<{ path: string; message: string }>;
    internalDetail?: string;
    logMessage: string;
    retryAfterSeconds?: number;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        details: exception.details,
        internalDetail: exception.internalDetail,
        logMessage: `handled ${exception.code}`,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: codeForStatus(status),
        // Nest's built-in messages (e.g. from a 404 route) are safe, but a
        // nested object response is not — flatten to a fixed string.
        message: safeHttpMessage(exception, status),
        logMessage: `http exception ${status}`,
      };
    }

    // Errors raised by the Express layer itself (body-parser, multipart) are
    // plain Errors carrying an HTTP status. Without this they would all be
    // reported as 500s, which is both wrong and unhelpful to the client.
    const expressStatus = httpStatusOf(exception);
    if (expressStatus !== null) {
      return {
        status: expressStatus,
        code: codeForStatus(expressStatus),
        message: GENERIC_MESSAGES[expressStatus] ?? 'The request could not be processed.',
        internalDetail: (exception as { type?: string }).type,
        logMessage: `request rejected by the http layer (${expressStatus})`,
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      // Database errors carry table and column names; they are logged, never
      // returned.
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'Something went wrong on our side. The incident has been recorded.',
        internalDetail: `prisma ${exception.code}`,
        logMessage: 'unhandled prisma error',
      };
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: ERROR_CODES.DEPENDENCY_UNAVAILABLE,
        message: 'A required service is temporarily unavailable. Please try again shortly.',
        logMessage: 'database unavailable',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ERROR_CODES.INTERNAL_ERROR,
      message: 'Something went wrong on our side. The incident has been recorded.',
      logMessage: 'unhandled exception',
    };
  }
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return ERROR_CODES.MALFORMED_REQUEST;
    case HttpStatus.UNAUTHORIZED:
      return ERROR_CODES.AUTH_REQUIRED;
    case HttpStatus.FORBIDDEN:
      return ERROR_CODES.FORBIDDEN;
    case HttpStatus.NOT_FOUND:
      return ERROR_CODES.NOT_FOUND;
    case HttpStatus.CONFLICT:
      return ERROR_CODES.CONFLICT;
    case HttpStatus.UNSUPPORTED_MEDIA_TYPE:
      return ERROR_CODES.UNSUPPORTED_MEDIA_TYPE;
    case HttpStatus.TOO_MANY_REQUESTS:
      return ERROR_CODES.RATE_LIMITED;
    case HttpStatus.NOT_IMPLEMENTED:
      return ERROR_CODES.NOT_IMPLEMENTED;
    case HttpStatus.SERVICE_UNAVAILABLE:
      return ERROR_CODES.DEPENDENCY_UNAVAILABLE;
    default:
      return status >= 500 ? ERROR_CODES.INTERNAL_ERROR : ERROR_CODES.MALFORMED_REQUEST;
  }
}

/**
 * Recognises an Express-layer error that already knows its HTTP status —
 * `PayloadTooLargeError`, malformed JSON from body-parser, and so on.
 */
function httpStatusOf(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null) return null;
  const candidate = exception as { status?: unknown; statusCode?: unknown; expose?: unknown };
  const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof status !== 'number') return null;
  if (status < 400 || status > 599) return null;
  return status;
}

const GENERIC_MESSAGES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'The request could not be processed.',
  [HttpStatus.UNAUTHORIZED]: 'Authentication is required.',
  [HttpStatus.FORBIDDEN]: 'You do not have access to this resource.',
  [HttpStatus.NOT_FOUND]: 'The requested resource was not found.',
  [HttpStatus.PAYLOAD_TOO_LARGE]: 'The request payload is too large.',
  [HttpStatus.INTERNAL_SERVER_ERROR]:
    'Something went wrong on our side. The incident has been recorded.',
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: 'Unsupported content type.',
};

function safeHttpMessage(exception: HttpException, status: number): string {
  const generic = GENERIC_MESSAGES[status];
  if (generic) return generic;
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (status >= 500) return 'Something went wrong on our side. The incident has been recorded.';
  const message = (response as { message?: unknown }).message;
  return typeof message === 'string' ? message : 'The request could not be processed.';
}
