import type { Metadata } from 'next';
import { PageHeader } from '@health/ui';
import { apiRequestOrSignIn } from '@/lib/guards';
import { AddressBook, type Address } from '@/components/address-book';

export const metadata: Metadata = { title: 'Addresses', robots: { index: false } };

export default async function AddressesPage() {
  const { data } = await apiRequestOrSignIn<{ data: Address[] }>('/api/v1/me/addresses');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Addresses"
        description="Where we send your orders. We currently ship within the United States only."
      />
      <AddressBook initial={data} />
    </div>
  );
}
