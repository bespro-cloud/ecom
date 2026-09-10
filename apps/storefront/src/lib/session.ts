import 'server-only';
import { cache } from 'react';
import type { PublicUser } from '@health/types';
import { getCurrentUser } from './api-client';

/**
 * The signed-in user for the current render.
 *
 * `cache()` deduplicates the lookup across a single request, so a layout and
 * three nested components asking "who is this?" cost one API call, not four.
 */
export const currentUser = cache(async (): Promise<PublicUser | null> => {
  return getCurrentUser<PublicUser>();
});
