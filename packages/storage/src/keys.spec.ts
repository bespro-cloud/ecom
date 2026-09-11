import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  contentAddressedKey,
  derivedKey,
  extensionForMimeType,
  safeDownloadFilename,
} from './keys.js';

const CHECKSUM = 'a'.repeat(64);

describe('checksumOf', () => {
  it('is stable for identical bytes and differs for any change', () => {
    expect(checksumOf(Buffer.from('hello'))).toBe(checksumOf(Buffer.from('hello')));
    expect(checksumOf(Buffer.from('hello'))).not.toBe(checksumOf(Buffer.from('hellp')));
    expect(checksumOf(Buffer.from('hello'))).toHaveLength(64);
  });
});

describe('contentAddressedKey', () => {
  it('fans out by the first two byte pairs', () => {
    expect(contentAddressedKey('products', CHECKSUM, 'jpg')).toBe(`products/aa/aa/${CHECKSUM}.jpg`);
  });

  it('accepts an extension with or without a leading dot', () => {
    expect(contentAddressedKey('products', CHECKSUM, '.png')).toBe(
      contentAddressedKey('products', CHECKSUM, 'png'),
    );
  });

  it('lower-cases the extension', () => {
    expect(contentAddressedKey('products', CHECKSUM, '.JPG').endsWith('.jpg')).toBe(true);
  });

  it('drops an extension it does not recognise rather than trusting it', () => {
    // The stored Content-Type decides how a file is served; an arbitrary
    // extension in the key would be a way of smuggling one in.
    expect(contentAddressedKey('products', CHECKSUM, '.php')).toBe(`products/aa/aa/${CHECKSUM}`);
    expect(contentAddressedKey('products', CHECKSUM, '.html')).not.toContain('html');
  });

  it('rejects anything that is not a SHA-256 digest', () => {
    expect(() => contentAddressedKey('products', 'short', 'jpg')).toThrow(RangeError);
    expect(() => contentAddressedKey('products', 'Z'.repeat(64), 'jpg')).toThrow(RangeError);
  });

  it('produces the same key for the same content, so a re-upload is a no-op', () => {
    const bytes = Buffer.from('the same image');
    const first = contentAddressedKey('products', checksumOf(bytes), 'png');
    const second = contentAddressedKey('products', checksumOf(bytes), 'png');
    expect(first).toBe(second);
  });
});

describe('derivedKey', () => {
  it('namespaces a rendition under its source checksum', () => {
    expect(derivedKey(CHECKSUM, 'medium', 'webp')).toBe(`derived/aa/${CHECKSUM}/medium.webp`);
  });

  it('rejects a transform name that could escape the prefix', () => {
    expect(() => derivedKey(CHECKSUM, '../../etc', 'webp')).toThrow(RangeError);
    expect(() => derivedKey(CHECKSUM, 'has spaces', 'webp')).toThrow(RangeError);
  });
});

describe('extensionForMimeType', () => {
  it('maps the formats we accept', () => {
    expect(extensionForMimeType('image/jpeg')).toBe('.jpg');
    expect(extensionForMimeType('image/webp')).toBe('.webp');
    expect(extensionForMimeType('application/pdf')).toBe('.pdf');
  });

  it('returns nothing for an unknown type', () => {
    expect(extensionForMimeType('text/html')).toBe('');
  });
});

describe('safeDownloadFilename', () => {
  it('keeps a reasonable name', () => {
    expect(safeDownloadFilename('certificate-of-analysis.pdf')).toBe('certificate-of-analysis.pdf');
  });

  it('strips directory components', () => {
    expect(safeDownloadFilename('../../etc/passwd')).toBe('passwd');
    expect(safeDownloadFilename('C:\\Windows\\system.ini')).toBe('system.ini');
  });

  it('removes characters that would break out of a header value', () => {
    const result = safeDownloadFilename('evil".pdf\r\nX-Injected: yes');
    expect(result).not.toContain('"');
    expect(result).not.toContain('\r');
    expect(result).not.toContain('\n');
  });

  it('falls back when there is nothing usable left', () => {
    expect(safeDownloadFilename('')).toBe('download');
    expect(safeDownloadFilename(null)).toBe('download');
  });

  it('caps the length', () => {
    expect(safeDownloadFilename(`${'a'.repeat(500)}.pdf`).length).toBeLessThanOrEqual(120);
  });
});
