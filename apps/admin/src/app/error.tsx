'use client';

import { useEffect } from 'react';
import { Alert, Button, Card } from '@health/ui';

/**
 * Route-level error boundary.
 *
 * `digest` is the only identifier Next.js exposes for a server-side failure —
 * the message and stack are deliberately withheld from the browser. Showing it
 * gives support something to correlate against the logs without leaking
 * anything.
 */
export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error in route', error.digest ?? error.message);
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <Card>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Something went wrong
        </h1>
        <div className="mt-4">
          <Alert tone="error">
            We could not load this page. The problem has been recorded and we are looking at it.
          </Alert>
        </div>
        {error.digest ? (
          <p className="mt-4 text-sm text-slate-500">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
        <div className="mt-6 flex gap-3">
          <Button onClick={reset}>Try again</Button>
          <Button variant="secondary" onClick={() => window.location.assign('/')}>
            Go to the homepage
          </Button>
        </div>
      </Card>
    </div>
  );
}
