import Link from 'next/link';
import type { PublicUser } from '@health/types';
import { publicConfig } from '@/lib/env';
import { SignOutButton } from './sign-out-button';

export function SiteHeader({ user }: { user: PublicUser | null }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <nav
        className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8"
        aria-label="Main"
      >
        <Link
          href="/"
          className="flex items-center gap-2 rounded text-lg font-semibold tracking-tight text-slate-900"
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-sm font-bold text-white"
          >
            HC
          </span>
          <span>{publicConfig.siteName}</span>
        </Link>

        <div className="flex items-center gap-1 sm:gap-3">
          <Link
            href="/products"
            className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
          >
            Products
          </Link>
          {user ? (
            <>
              <Link
                href="/account"
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Your account
              </Link>
              <SignOutButton />
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="rounded-lg px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700"
              >
                Create account
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
