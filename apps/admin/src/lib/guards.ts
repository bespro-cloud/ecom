import 'server-only';
import { redirect } from 'next/navigation';
import { ApiError, apiRequest, type ApiRequestOptions } from './api-client';

/**
 * Fetches data for a signed-in page.
 *
 * A 401 here means the session expired between the middleware check and the
 * render — a real race, not an error worth showing. Redirecting keeps the user
 * moving; anything else propagates to the error boundary as it should.
 */
export async function apiRequestOrSignIn<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  try {
    return await apiRequest<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.isAuthError) {
      redirect('/sign-in?reason=session-expired');
    }
    throw error;
  }
}
