import { createHash } from 'node:crypto';
import { extname } from 'node:path';

/**
 * Storage key derivation.
 *
 * Keys are content-addressed: the SHA-256 of the bytes decides the key. Three
 * consequences, all of them wanted:
 *
 *  - Uploading the same file twice writes the same key, so it costs nothing and
 *    creates no duplicate.
 *  - A key can be cached forever, because different content is a different key.
 *  - The original filename — which is attacker-controlled and often contains
 *    path separators, control characters or someone's name — never reaches the
 *    object store.
 */

export type MediaPrefix = 'products' | 'documents' | 'content' | 'derived';

export function checksumOf(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * `products/ab/cd/abcdef…1234.jpg`
 *
 * The two-level fan-out keeps any single prefix from accumulating millions of
 * objects, which some S3-compatible stores handle poorly when listing.
 */
export function contentAddressedKey(
  prefix: MediaPrefix,
  checksum: string,
  extension: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(checksum)) {
    throw new RangeError('checksum must be a 64-character hex SHA-256 digest');
  }
  const normalised = normaliseExtension(extension);
  return `${prefix}/${checksum.slice(0, 2)}/${checksum.slice(2, 4)}/${checksum}${normalised}`;
}

/**
 * Key for a generated rendition (a resized image).
 *
 * Derived from the source checksum plus the transform, so regenerating the same
 * rendition is idempotent and a changed source produces a different key.
 */
export function derivedKey(checksum: string, transform: string, extension: string): string {
  if (!/^[a-z0-9_-]{1,64}$/.test(transform)) {
    throw new RangeError('transform must be a short lower-case identifier');
  }
  return `derived/${checksum.slice(0, 2)}/${checksum}/${transform}${normaliseExtension(extension)}`;
}

const ALLOWED_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.gif',
  '.svg',
  '.pdf',
]);

function normaliseExtension(extension: string): string {
  const withDot = extension.startsWith('.') ? extension : `.${extension}`;
  const lowered = withDot.toLowerCase();
  // An unrecognised extension becomes none at all rather than being trusted:
  // the stored Content-Type is what decides how a file is served.
  return ALLOWED_EXTENSIONS.has(lowered) ? lowered : '';
}

/** Extension for a MIME type, for building a key from an upload. */
export function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/avif':
      return '.avif';
    case 'image/gif':
      return '.gif';
    case 'image/svg+xml':
      return '.svg';
    case 'application/pdf':
      return '.pdf';
    default:
      return '';
  }
}

/**
 * A filename safe to put in a Content-Disposition header.
 *
 * Strips directory separators, control characters and anything that could
 * terminate the header value.
 */
export function safeDownloadFilename(original: string | null | undefined): string {
  if (!original) return 'download';
  const base = original.split(/[/\\]/).pop() ?? 'download';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : `download${extname(base).toLowerCase()}`;
}
