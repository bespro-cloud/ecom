import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, type ErrorCode } from '@health/types';

export interface AppExceptionOptions {
  /** Field-level problems, for VALIDATION_FAILED. */
  details?: Array<{ path: string; message: string }>;
  /** Detail recorded in logs only — never sent to the client. */
  internalDetail?: string;
  cause?: unknown;
}

/**
 * The only exception type the application throws deliberately.
 *
 * It carries a stable machine code plus a message that is safe to show a user.
 * Anything sensitive goes in `internalDetail`, which the exception filter logs
 * but never serialises into the response.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details?: Array<{ path: string; message: string }>;
  readonly internalDetail?: string;

  constructor(
    code: ErrorCode,
    status: HttpStatus,
    publicMessage: string,
    options: AppExceptionOptions = {},
  ) {
    super(publicMessage, status, { cause: options.cause });
    this.code = code;
    this.details = options.details;
    this.internalDetail = options.internalDetail;
  }

  static validation(
    details: Array<{ path: string; message: string }>,
    message = 'The request contains invalid values.',
  ): AppException {
    return new AppException(ERROR_CODES.VALIDATION_FAILED, HttpStatus.BAD_REQUEST, message, {
      details,
    });
  }

  static unauthorized(
    code: ErrorCode = ERROR_CODES.AUTH_REQUIRED,
    message = 'Authentication is required.',
    options?: AppExceptionOptions,
  ): AppException {
    return new AppException(code, HttpStatus.UNAUTHORIZED, message, options);
  }

  static forbidden(
    code: ErrorCode = ERROR_CODES.FORBIDDEN,
    message = 'You do not have access to this resource.',
    options?: AppExceptionOptions,
  ): AppException {
    return new AppException(code, HttpStatus.FORBIDDEN, message, options);
  }

  static notFound(resource = 'Resource', options?: AppExceptionOptions): AppException {
    return new AppException(
      ERROR_CODES.NOT_FOUND,
      HttpStatus.NOT_FOUND,
      `${resource} was not found.`,
      options,
    );
  }

  static conflict(
    message: string,
    code: ErrorCode = ERROR_CODES.CONFLICT,
    options?: AppExceptionOptions,
  ): AppException {
    return new AppException(code, HttpStatus.CONFLICT, message, options);
  }

  static preconditionFailed(message: string, options?: AppExceptionOptions): AppException {
    return new AppException(
      ERROR_CODES.PRECONDITION_FAILED,
      HttpStatus.UNPROCESSABLE_ENTITY,
      message,
      options,
    );
  }

  static rateLimited(message = 'Too many requests. Please try again shortly.'): AppException {
    return new AppException(ERROR_CODES.RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS, message);
  }

  static internal(internalDetail: string, cause?: unknown): AppException {
    return new AppException(
      ERROR_CODES.INTERNAL_ERROR,
      HttpStatus.INTERNAL_SERVER_ERROR,
      'Something went wrong on our side. The incident has been recorded.',
      { internalDetail, cause },
    );
  }

  static dependencyUnavailable(dependency: string): AppException {
    return new AppException(
      ERROR_CODES.DEPENDENCY_UNAVAILABLE,
      HttpStatus.SERVICE_UNAVAILABLE,
      'A required service is temporarily unavailable. Please try again shortly.',
      { internalDetail: `dependency unavailable: ${dependency}` },
    );
  }
}
