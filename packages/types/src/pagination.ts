export interface PageMeta {
  /** Cursor for the next page, or null when the result set is exhausted. */
  nextCursor: string | null;
  /** Number of items in this page. */
  count: number;
  /** Page size that was applied (may be lower than requested). */
  limit: number;
}

export interface Paginated<T> {
  data: T[];
  meta: PageMeta;
}

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
