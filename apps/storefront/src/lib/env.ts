import { z } from 'zod';

/**
 * Server-side configuration for the storefront.
 *
 * `API_INTERNAL_URL` is the address the Next.js server uses to reach the API —
 * inside the container network, not through the public internet. It is never
 * sent to the browser: the browser only ever talks to this app's own origin.
 */
const schema = z.object({
  API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),
  NEXT_PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
  NEXT_PUBLIC_SITE_NAME: z.string().default('Health Commerce'),
});

let cached: z.infer<typeof schema> | null = null;

export function serverEnv(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Storefront configuration is invalid:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  cached = parsed.data;
  return cached;
}

/** Values that are safe to render into the page. */
export const publicConfig = {
  siteName: process.env.NEXT_PUBLIC_SITE_NAME ?? 'Health Commerce',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
};
