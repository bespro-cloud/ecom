/**
 * Formatting helpers.
 *
 * All money is handled as integer minor units and formatted here; a float
 * never touches a price. (Used from Phase 3 onward; defined now so there is one
 * place for it.)
 */
export function formatMoney(minorUnits: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minorUnits / 100);
}

export function formatDate(value: string | Date, locale = 'en-US'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

export function formatDateTime(value: string | Date, locale = 'en-US'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

/** "3 days ago" — falls back to an absolute date beyond a month. */
export function formatRelative(value: string | Date, now = new Date(), locale = 'en-US'): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);

  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (absolute < 60) return formatter.format(Math.round(seconds), 'second');
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (absolute < 2592000) return formatter.format(Math.round(seconds / 86400), 'day');
  return formatDate(date, locale);
}
