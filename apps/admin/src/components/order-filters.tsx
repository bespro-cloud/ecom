/**
 * Order list filters.
 *
 * A plain GET form for the same reason the catalogue filters are: the filtered
 * view lives in the URL, so it can be pasted into a ticket and survives a
 * refresh, and the server renders exactly what the query says.
 *
 * The email box searches for an exact address rather than a fragment. Partial
 * matching across customer emails turns an order lookup into a way to enumerate
 * the customer list, which is not what an order screen is for.
 */
export function OrderFilters({
  params,
}: {
  params: Record<string, string | string[] | undefined>;
}) {
  const value = (key: string): string => {
    const current = params[key];
    return (Array.isArray(current) ? current[0] : current) ?? '';
  };

  return (
    <form method="get" className="flex flex-wrap items-end gap-3">
      <div className="min-w-40">
        <label htmlFor="order-reference" className="block text-sm font-medium text-slate-700">
          Reference
        </label>
        <input
          id="order-reference"
          type="search"
          name="reference"
          defaultValue={value('reference')}
          placeholder="HC-2026-XXXXXX"
          maxLength={40}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      <div className="min-w-56 flex-1">
        <label htmlFor="order-email" className="block text-sm font-medium text-slate-700">
          Customer email
        </label>
        <input
          id="order-email"
          type="email"
          name="email"
          defaultValue={value('email')}
          placeholder="Exact address"
          maxLength={320}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      <div>
        <label htmlFor="order-status" className="block text-sm font-medium text-slate-700">
          Status
        </label>
        <select
          id="order-status"
          name="status"
          defaultValue={value('status')}
          className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        >
          <option value="">Any</option>
          {[
            'PENDING_PAYMENT',
            'PAID',
            'PROCESSING',
            'PARTIALLY_FULFILLED',
            'FULFILLED',
            'PARTIALLY_REFUNDED',
            'REFUNDED',
            'CANCELLED',
          ].map((status) => (
            <option key={status} value={status}>
              {status.toLowerCase().replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="order-from" className="block text-sm font-medium text-slate-700">
          Placed from
        </label>
        <input
          id="order-from"
          type="date"
          name="from"
          defaultValue={value('from')}
          className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      <div>
        <label htmlFor="order-to" className="block text-sm font-medium text-slate-700">
          to
        </label>
        <input
          id="order-to"
          type="date"
          name="to"
          defaultValue={value('to')}
          className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      <button
        type="submit"
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Apply
      </button>
    </form>
  );
}
