'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

const TOPICS = [
  { value: 'ORDER', label: 'An order' },
  { value: 'DELIVERY', label: 'Delivery' },
  { value: 'RETURN_OR_REFUND', label: 'A return or refund' },
  { value: 'PRODUCT_QUESTION', label: 'A question about a product' },
  { value: 'SUBSCRIPTION', label: 'A subscription' },
  { value: 'ACCOUNT', label: 'My account' },
  { value: 'OTHER', label: 'Something else' },
] as const;

/**
 * Starting a conversation.
 *
 * The medical redirect is shown **before** the box, not after. A notice that
 * appears once someone has already written out their symptoms has collected the
 * health information it was meant to prevent.
 *
 * There is deliberately no "medical question" topic: this business cannot
 * answer one, and offering the option would invite data it has no lawful basis
 * to hold.
 */
export function SupportComposer({
  medicalRedirect,
  orders,
}: {
  medicalRedirect: string;
  orders: Array<{ id: string; reference: string }>;
}) {
  const router = useRouter();
  const [topic, setTopic] = useState<string>('ORDER');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [orderId, setOrderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const thread = await clientRequest<{ id: string }>('/api/v1/account/support', {
        method: 'POST',
        body: { topic, subject, body, ...(orderId ? { orderId } : {}) },
      });
      router.push(`/account/support/${thread.id}`);
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not send your message. Please try again.');
      }
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5" noValidate>
      <Alert tone="warning" title="We cannot help with health questions">
        <p>{medicalRedirect}</p>
      </Alert>

      {error ? <Alert tone="error">{error}</Alert> : null}

      <SelectField
        label="What is this about?"
        required
        value={topic}
        error={fieldErrors.topic}
        onChange={(event) => setTopic(event.target.value)}
      >
        {TOPICS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>

      {orders.length > 0 ? (
        <SelectField
          label="Which order? (optional)"
          value={orderId}
          error={fieldErrors.orderId}
          onChange={(event) => setOrderId(event.target.value)}
        >
          <option value="">Not about a specific order</option>
          {orders.map((order) => (
            <option key={order.id} value={order.id}>
              {order.reference}
            </option>
          ))}
        </SelectField>
      ) : null}

      <Field
        label="Subject"
        required
        value={subject}
        maxLength={200}
        error={fieldErrors.subject}
        onChange={(event) => setSubject(event.target.value)}
      />

      <TextareaField
        label="Your message"
        required
        rows={7}
        value={body}
        maxLength={4000}
        error={fieldErrors.body}
        hint="Please do not include details about your health, medication or symptoms."
        onChange={(event) => setBody(event.target.value)}
      />

      <Button type="submit" loading={busy} loadingLabel="Sending…">
        Send message
      </Button>
    </form>
  );
}
