'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Button, Field, SelectField, TextareaField } from '@health/ui';
import { ClientApiError, clientRequest } from '@/lib/client';

export interface PurchaseOption {
  orderItemId: string;
  orderReference: string;
  variantName: string;
  placedAt: string;
}

/**
 * Writing a review.
 *
 * Two things this form deliberately does not do.
 *
 * It does not decide the verified-purchase badge. The customer picks which of
 * *their own* orders the review is about and the API derives the badge from
 * that order line; a purchase that is not theirs is refused rather than
 * silently un-badged. There is no field here that sets the badge.
 *
 * It does not promise publication. The success message says a person will read
 * it first, because on a regulated product that is the truth and a review that
 * silently never appears reads as a bug.
 */
export function WriteReviewForm({
  productId,
  productName,
  purchases,
  defaultDisplayName,
}: {
  productId: string;
  productName: string;
  purchases: PurchaseOption[];
  defaultDisplayName: string;
}) {
  const router = useRouter();
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const [orderItemId, setOrderItemId] = useState(purchases[0]?.orderItemId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});

    try {
      const response = await clientRequest<{ visibility: string }>('/api/v1/account/reviews', {
        method: 'POST',
        body: {
          productId,
          rating,
          body,
          authorDisplayName: displayName,
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(orderItemId ? { orderItemId } : {}),
        },
      });
      setDone(response.visibility);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ClientApiError) {
        setFieldErrors(caught.fieldErrors);
        setError(caught.message);
      } else {
        setError('We could not save your review. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <Alert tone="success" title="Thank you — your review has been received">
        <p>{done}</p>
        <div className="mt-3">
          <Button variant="secondary" onClick={() => router.push('/account/reviews')}>
            See your reviews
          </Button>
        </div>
      </Alert>
    );
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-5" noValidate>
      {error ? <Alert tone="error">{error}</Alert> : null}

      <fieldset>
        <legend className="text-sm font-medium text-slate-900">
          Your rating for {productName}
        </legend>
        <div className="mt-2 flex gap-2">
          {[1, 2, 3, 4, 5].map((value) => (
            <label
              key={value}
              className={`cursor-pointer rounded-lg px-3 py-2 text-sm font-medium ring-1 transition-colors ${
                rating === value
                  ? 'bg-brand-50 text-brand-800 ring-brand-300'
                  : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'
              }`}
            >
              <input
                type="radio"
                name="rating"
                value={value}
                checked={rating === value}
                onChange={() => setRating(value)}
                className="sr-only"
              />
              {value} {value === 1 ? 'star' : 'stars'}
            </label>
          ))}
        </div>
        {fieldErrors.rating ? (
          <p className="mt-1 text-sm text-rose-700">{fieldErrors.rating}</p>
        ) : null}
      </fieldset>

      {purchases.length > 0 ? (
        <SelectField
          label="Which purchase is this about?"
          hint="Choosing an order adds a “verified purchase” badge to your review."
          value={orderItemId}
          error={fieldErrors.orderItemId}
          onChange={(event) => setOrderItemId(event.target.value)}
        >
          <option value="">I would rather not say</option>
          {purchases.map((purchase) => (
            <option key={purchase.orderItemId} value={purchase.orderItemId}>
              {purchase.orderReference} — {purchase.variantName}
            </option>
          ))}
        </SelectField>
      ) : null}

      <Field
        label="Headline"
        hint="Optional."
        value={title}
        maxLength={120}
        error={fieldErrors.title}
        onChange={(event) => setTitle(event.target.value)}
      />

      <TextareaField
        label="Your review"
        required
        rows={6}
        value={body}
        maxLength={4000}
        error={fieldErrors.body}
        hint="What you thought of the product. Please don’t include personal health details — this is shown publicly."
        onChange={(event) => setBody(event.target.value)}
      />

      <Field
        label="Name to show with your review"
        required
        value={displayName}
        maxLength={60}
        error={fieldErrors.authorDisplayName}
        hint="Shown publicly, so use a name rather than an email address."
        onChange={(event) => setDisplayName(event.target.value)}
      />

      <Alert tone="info" title="Before you post">
        <p>
          Reviews are read by our team before they appear. We cannot publish claims that a product
          treats, prevents or cures a disease, and we may ask you to reword a review that makes one.
        </p>
      </Alert>

      <Button type="submit" loading={saving} loadingLabel="Sending…">
        Submit review
      </Button>
    </form>
  );
}
