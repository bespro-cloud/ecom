import { redirect } from 'next/navigation';
import { currentUser } from '@/lib/session';
import { AccountNav } from '@/components/account-nav';

/**
 * Shell for the account area.
 *
 * `middleware.ts` has already turned away anyone without a session cookie, so
 * reaching here without a user means the session expired in between. The API
 * is the real authorisation boundary in both cases — these checks only decide
 * where to send the person next.
 */
export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect('/login?next=/account');

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-8 lg:flex-row">
        <aside className="lg:w-56 lg:shrink-0">
          <h2 className="sr-only">Account navigation</h2>
          <AccountNav />
          <p className="mt-6 hidden text-xs text-slate-500 lg:block">
            Signed in as
            <br />
            <span className="font-medium text-slate-700">{user.email}</span>
          </p>
        </aside>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
