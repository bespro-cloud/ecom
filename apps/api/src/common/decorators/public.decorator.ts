import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks a route as reachable without authentication.
 *
 * Authentication is on by default (the guard is global), so forgetting this
 * decorator fails closed — an endpoint is never accidentally public.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
