'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';

const LINKS = [
  { href: '/account', label: 'Overview' },
  { href: '/account/addresses', label: 'Addresses' },
  { href: '/account/security', label: 'Security' },
] as const;

export function AccountNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Account">
      <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5">
        {LINKS.map((link) => {
          const active = pathname === link.href;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={active ? 'page' : undefined}
                className={clsx(
                  'block whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'bg-brand-50 text-brand-800'
                    : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
