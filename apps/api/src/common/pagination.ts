/**
 * Cursor pagination helpers.
 *
 * The cursor is an opaque, base64url-encoded row id. Encoding it discourages
 * clients from constructing their own, which keeps the ordering key an
 * implementation detail we can change later.
 */
export function encodeCursor(id: string | undefined): string | null {
  if (!id) return null;
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    // Must look like a UUID: anything else is a malformed or hostile cursor and
    // is treated as "start from the beginning" rather than reaching the query.
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}
