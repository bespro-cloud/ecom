/**
 * Catalogue list filters.
 *
 * A plain GET form, submitting to the same route. That keeps the filtered view
 * in the URL — shareable in a ticket, survivable across a refresh — and it
 * means the server renders exactly what the query says, with no client state
 * that could disagree with it.
 */
export function ProductFilters({
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
      <div className="min-w-48 flex-1">
        <label htmlFor="catalogue-search" className="block text-sm font-medium text-slate-700">
          Search
        </label>
        <input
          id="catalogue-search"
          type="search"
          name="search"
          defaultValue={value('search')}
          placeholder="Name, SKU or brand"
          maxLength={200}
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
        />
      </div>

      <Select
        id="catalogue-status"
        name="status"
        label="Status"
        value={value('status')}
        options={['DRAFT', 'IN_REVIEW', 'READY', 'PUBLISHED', 'ARCHIVED']}
      />
      <Select
        id="catalogue-compliance"
        name="complianceStatus"
        label="Compliance"
        value={value('complianceStatus')}
        options={['NOT_REVIEWED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED']}
      />
      <Select
        id="catalogue-type"
        name="type"
        label="Type"
        value={value('type')}
        options={['SUPPLEMENT', 'COSMETIC', 'FOOD', 'DEVICE', 'WELLNESS', 'ACCESSORY']}
      />

      <button
        type="submit"
        className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
      >
        Apply
      </button>
    </form>
  );
}

function Select({
  id,
  name,
  label,
  value,
  options,
}: {
  id: string;
  name: string;
  label: string;
  value: string;
  options: string[];
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      <select
        id={id}
        name={name}
        defaultValue={value}
        className="mt-1 rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
      >
        <option value="">Any</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option.toLowerCase().replace(/_/g, ' ')}
          </option>
        ))}
      </select>
    </div>
  );
}
