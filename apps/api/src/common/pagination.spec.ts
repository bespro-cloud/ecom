import { decodeCursor, encodeCursor } from './pagination.js';

describe('cursor encoding', () => {
  const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

  it('round-trips a row id', () => {
    expect(decodeCursor(encodeCursor(id)!)).toBe(id);
  });

  it('produces an opaque, url-safe value', () => {
    const cursor = encodeCursor(id)!;
    expect(cursor).not.toContain(id);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('returns null when there is nothing to encode', () => {
    expect(encodeCursor(undefined)).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('rejects a cursor that does not decode to an id', () => {
    // A hostile cursor must not reach the query as an ordering key.
    const forged = Buffer.from("' OR 1=1 --", 'utf8').toString('base64url');
    expect(decodeCursor(forged)).toBeNull();
    expect(decodeCursor('!!!not base64!!!')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });
});
