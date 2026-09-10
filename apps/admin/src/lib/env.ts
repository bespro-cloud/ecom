import { z } from 'zod';

/**
 * Server-side configuration for the admin console.
 *
 * As on the storefront, the browser only ever talks to this app's own origin —
 * `API_INTERNAL_URL` is the address the Next.js server uses to reach the API
 * across the container network and is never exposed to the client.
 */
const schema = z.object({
  API_INTERNAL_URL: z.string().url().default('http://localhost:4000'),
  NEXT_PUBLIC_ADMIN_URL: z.string().url().default('http://localhost:3001'),
});

let cached: z.infer<typeof schema> | null = null;

export function serverEnv(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Admin configuration is invalid:\n${parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  cached = parsed.data;
  return cached;
}

export const publicConfig = {
  appName: 'Health Commerce Admin',
};
