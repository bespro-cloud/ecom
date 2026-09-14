import type { Metadata } from 'next';
import { Card, PageHeader } from '@health/ui';
import { fetchOrders } from '@/lib/commerce';
import { fetchSupportGuidance } from '@/lib/lifecycle';
import { SupportComposer } from '@/components/support-composer';

export const metadata: Metadata = { title: 'Start a conversation', robots: { index: false } };

export default async function NewSupportThreadPage() {
  const [guidance, orders] = await Promise.all([fetchSupportGuidance(), fetchOrders()]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Start a conversation"
        description="Tell us what happened and we will pick it up."
      />
      <Card>
        <SupportComposer
          medicalRedirect={guidance.medicalRedirect}
          orders={orders.map((order) => ({ id: order.id, reference: order.reference }))}
        />
      </Card>
    </div>
  );
}
