import 'server-only';
import { serverEnv } from './env';

/**
 * Asks the API whether a path has moved.
 *
 * Called from middleware, on the way in, for paths that would otherwise 404.
 * Deliberately not called for every request: the overwhelmingly common case is
 * a page that exists, and adding a round trip to it would make the whole site
 * slower to save a redirect lookup that almost never applies.
 *
 * Fails open. If the API is unreachable, the visitor gets the page they asked
 * for (or its 404) rather than an error — a redirect service being down must
 * not take the site down with it.
 */
export async function lookupRedirect(
  path: string,
): Promise<{ toPath: string; statusCode: number } | null> {
  try {
    const response = await fetch(`${serverEnv().API_INTERNAL_URL}/api/v1/redirects/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      // Redirects change rarely and are read on every miss, so a short cache
      // is worth it — but not so long that fixing a wrong one takes an hour.
      next: { revalidate: 60 },
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as {
      redirect: { toPath: string; statusCode: number } | null;
    };
    return payload.redirect;
  } catch {
    return null;
  }
}

/**
 * Serves a redirect if the requested path has moved, and 404s otherwise.
 *
 * Called from a page's not-found branch rather than from middleware, and that
 * is the whole design decision here. Middleware would have to ask the API about
 * *every* request on the chance that it moved; almost none have. Asking only
 * when the page genuinely does not exist costs nothing on the path that matters
 * and answers correctly on the path that does not.
 *
 * `permanentRedirect` emits a 308 rather than the 301 stored on the rule. Both
 * are permanent and search engines treat them the same; 308 additionally
 * preserves the request method, which is the safer of the two to serve from a
 * framework that does not know what method it is handling.
 */
export async function redirectOrNotFound(path: string): Promise<never> {
  const { notFound, permanentRedirect, redirect } = await import('next/navigation');

  const moved = await lookupRedirect(path);
  if (moved === null) {
    notFound();
  } else if (moved.statusCode === 302) {
    redirect(moved.toPath);
  } else {
    permanentRedirect(moved.toPath);
  }

  // Unreachable: every branch above throws. Present because TypeScript cannot
  // see through the dynamic import that these return `never`.
  throw new Error('unreachable');
}
