import type { Metadata } from 'next';
import { Card, PageHeader } from '@health/ui';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { NewProductForm } from '@/components/new-product-form';

export const metadata: Metadata = { title: 'New product' };

export default async function NewProductPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'PRODUCT_WRITE')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="PRODUCT_WRITE" />
      </ConsoleShell>
    );
  }

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="New product"
          description="Created as a draft. There is no path from this form to a publicly visible listing."
        />
        <Card>
          <NewProductForm />
        </Card>
      </div>
    </ConsoleShell>
  );
}
