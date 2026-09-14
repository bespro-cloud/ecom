'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { clsx } from 'clsx';
import { Badge, Button } from '@health/ui';
import type { PermissionKey, PublicUser } from '@health/types';
import { clientRequest } from '@/lib/client';

interface NavItem {
  href: string;
  label: string;
  /** Hidden when the signed-in user lacks this permission. */
  permission?: PermissionKey;
}

const NAV: NavItem[] = [
  { href: '/', label: 'Overview' },
  { href: '/catalogue', label: 'Catalogue', permission: 'PRODUCT_READ' },
  { href: '/catalogue/categories', label: 'Categories', permission: 'CATEGORY_READ' },
  { href: '/catalogue/ingredients', label: 'Ingredients', permission: 'INGREDIENT_READ' },
  { href: '/catalogue/media', label: 'Media', permission: 'PRODUCT_READ' },
  { href: '/orders', label: 'Orders', permission: 'ORDER_READ' },
  { href: '/inventory', label: 'Inventory', permission: 'INVENTORY_READ' },
  { href: '/inventory/warehouses', label: 'Warehouses', permission: 'INVENTORY_READ' },
  { href: '/shipping', label: 'Shipping rates', permission: 'ORDER_READ' },
  { href: '/content', label: 'Pages', permission: 'CONTENT_READ' },
  { href: '/compliance', label: 'Compliance', permission: 'COMPLIANCE_READ' },
  { href: '/claims', label: 'Claims', permission: 'CLAIM_READ' },
  { href: '/evidence', label: 'Evidence', permission: 'EVIDENCE_READ' },
  { href: '/lots', label: 'Lots', permission: 'BATCH_READ' },
  { href: '/recalls', label: 'Recalls', permission: 'RECALL_READ' },
  { href: '/users', label: 'Staff & customers', permission: 'USER_READ' },
  { href: '/roles', label: 'Roles & permissions', permission: 'ROLE_READ' },
  { href: '/audit', label: 'Audit log', permission: 'AUDIT_READ' },
  { href: '/settings', label: 'Settings & flags', permission: 'SYSTEM_SETTINGS' },
];

/**
 * Navigation is filtered by the permissions the signed-in user actually holds.
 *
 * This is a courtesy, not a control: hiding a link changes nothing about who
 * can call the endpoint behind it. The API refuses the request either way.
 */
export function ConsoleShell({ user, children }: { user: PublicUser; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const held = new Set(user.permissions);
  const visible = NAV.filter((item) => !item.permission || held.has(item.permission));

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await clientRequest('/api/v1/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/sign-in');
      router.refresh();
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white"
            >
              HC
            </span>
            <span className="text-sm font-semibold text-slate-900">Admin</span>
          </div>

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium text-slate-900">{user.email}</p>
              <p className="text-xs text-slate-500">{user.roles.join(', ') || 'No roles'}</p>
            </div>
            {user.mfaEnabled ? (
              <Badge tone="success">2FA on</Badge>
            ) : (
              <Badge tone="warning">2FA off</Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              loading={signingOut}
              loadingLabel="Signing out…"
              onClick={() => void signOut()}
            >
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <nav aria-label="Sections" className="hidden w-56 shrink-0 lg:block">
          <ul className="space-y-0.5">
            {visible.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'block rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-brand-50 text-brand-800'
                        : 'text-slate-700 hover:bg-white hover:text-slate-900',
                    )}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">
          <nav aria-label="Sections" className="mb-6 lg:hidden">
            <ul className="flex gap-1 overflow-x-auto pb-1">
              {visible.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="block whitespace-nowrap rounded-lg bg-white px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200"
                  >
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <main id="main-content">{children}</main>
        </div>
      </div>
    </div>
  );
}
