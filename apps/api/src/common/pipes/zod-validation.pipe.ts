import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';
import { AppException } from '../errors/app-exception.js';

/**
 * Validates and *replaces* the incoming value with the parsed result.
 *
 * Using the parsed output rather than the raw input is what makes the pipe a
 * real boundary: unknown properties are stripped, coercions are applied once,
 * and downstream code receives a value that matches its declared type.
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw AppException.validation(
          error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

/** Convenience factory: `@Body(zodBody(loginSchema))`. */
export function zodBody<T>(schema: ZodSchema<T>): ZodValidationPipe<T> {
  return new ZodValidationPipe(schema);
}
