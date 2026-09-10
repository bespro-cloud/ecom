import Link from 'next/link';
import { publicConfig } from '@/lib/env';

export function SiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-prose">
            <p className="text-sm font-semibold text-slate-900">{publicConfig.siteName}</p>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              These statements have not been evaluated by the Food and Drug Administration. Products
              sold here are not intended to diagnose, treat, cure or prevent any disease.
            </p>
          </div>
          <nav aria-label="Footer" className="text-sm">
            <ul className="space-y-2">
              <li>
                <Link href="/account" className="text-slate-600 hover:text-slate-900">
                  Your account
                </Link>
              </li>
              <li>
                <Link href="/login" className="text-slate-600 hover:text-slate-900">
                  Sign in
                </Link>
              </li>
            </ul>
          </nav>
        </div>
        <p className="mt-8 text-xs text-slate-500">
          © {new Date().getFullYear()} {publicConfig.siteName}. Ships within the United States.
        </p>
      </div>
    </footer>
  );
}
