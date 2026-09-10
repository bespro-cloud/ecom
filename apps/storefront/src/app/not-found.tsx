import Link from 'next/link';
import { Button, Card } from '@health/ui';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <Card>
        <p className="text-sm font-semibold uppercase tracking-wide text-brand-700">404</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-900">
          We could not find that page
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          The link may be out of date, or the page may have moved.
        </p>
        <div className="mt-6">
          <Link href="/">
            <Button>Go to the homepage</Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
