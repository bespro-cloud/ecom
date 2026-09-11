import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import {
  DEFAULT_RENDITIONS,
  UnsupportedImageError,
  generateRendition,
  inspectImage,
  normaliseOriginal,
} from './images.js';

async function makeImage(
  width: number,
  height: number,
  format: 'jpeg' | 'png' | 'webp' | 'gif' = 'jpeg',
): Promise<Buffer> {
  const base = sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 95 } },
  });
  if (format === 'png') return base.png().toBuffer();
  if (format === 'webp') return base.webp().toBuffer();
  if (format === 'gif') return base.gif().toBuffer();
  return base.jpeg().toBuffer();
}

describe('inspectImage', () => {
  it('reads dimensions and format from the bytes', async () => {
    const metadata = await inspectImage(await makeImage(800, 600));
    expect(metadata).toMatchObject({
      width: 800,
      height: 600,
      format: 'jpeg',
      mimeType: 'image/jpeg',
    });
  });

  it('recognises the formats we accept', async () => {
    for (const format of ['jpeg', 'png', 'webp', 'gif'] as const) {
      const metadata = await inspectImage(await makeImage(64, 64, format));
      expect(metadata.format).toBe(format);
    }
  });

  it('rejects a file that is not an image, whatever it claims to be', async () => {
    // A stored HTML document served from the storefront origin is XSS; the
    // declared Content-Type is chosen by the uploader and proves nothing.
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    await expect(inspectImage(html)).rejects.toBeInstanceOf(UnsupportedImageError);
  });

  it('rejects SVG, which can carry script', async () => {
    // Serving user-supplied SVG from the storefront origin is straightforward
    // XSS. Whether the rejection comes from the decoder (builds without
    // librsvg) or from the format allow-list (builds with it), the outcome that
    // matters is the same: it never becomes a stored image.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    await expect(inspectImage(svg)).rejects.toBeInstanceOf(UnsupportedImageError);
  });

  it('rejects truncated or corrupt data', async () => {
    const truncated = (await makeImage(200, 200)).subarray(0, 40);
    await expect(inspectImage(truncated)).rejects.toBeInstanceOf(UnsupportedImageError);
    await expect(inspectImage(Buffer.alloc(0))).rejects.toBeInstanceOf(UnsupportedImageError);
  });
});

describe('generateRendition', () => {
  it('resizes to the requested width and preserves aspect ratio', async () => {
    const source = await makeImage(2000, 1000);
    const rendition = await generateRendition(source, DEFAULT_RENDITIONS[1]!);

    expect(rendition.width).toBe(400);
    expect(rendition.height).toBe(200);
    expect(rendition.mimeType).toBe('image/webp');
    expect(rendition.extension).toBe('.webp');
  });

  it('does not upscale a source smaller than the target', async () => {
    // Upscaling produces a bigger file that looks worse.
    const source = await makeImage(120, 120);
    const rendition = await generateRendition(source, DEFAULT_RENDITIONS[3]!);
    expect(rendition.width).toBe(120);
  });

  it('produces a materially smaller file than the original', async () => {
    const source = await makeImage(2400, 1600, 'png');
    const rendition = await generateRendition(source, DEFAULT_RENDITIONS[0]!);
    expect(rendition.body.byteLength).toBeLessThan(source.byteLength);
  });
});

describe('normaliseOriginal', () => {
  it('strips EXIF, including location data', async () => {
    const withExif = await sharp({
      create: { width: 100, height: 100, channels: 3, background: '#336' },
    })
      .withExif({
        IFD0: { Copyright: 'Test', Artist: 'Someone' },
        IFD2: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'W' },
      })
      .jpeg()
      .toBuffer();

    const sourceMeta = await sharp(withExif).metadata();
    expect(sourceMeta.exif).toBeDefined();

    const metadata = await inspectImage(withExif);
    const normalised = await normaliseOriginal(withExif, metadata);

    // Publishing a product photo must not publish the warehouse's coordinates.
    const resultMeta = await sharp(normalised.body).metadata();
    expect(resultMeta.exif).toBeUndefined();
  });

  it('keeps transparency by re-encoding to PNG', async () => {
    const transparent = await sharp({
      create: { width: 50, height: 50, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .png()
      .toBuffer();

    const metadata = await inspectImage(transparent);
    expect(metadata.hasAlpha).toBe(true);

    const normalised = await normaliseOriginal(transparent, metadata);
    expect(normalised.mimeType).toBe('image/png');
    expect(normalised.extension).toBe('.png');
  });

  it('passes an animated GIF through rather than flattening it', async () => {
    const gif = await makeImage(60, 60, 'gif');
    const metadata = await inspectImage(gif);
    const normalised = await normaliseOriginal(gif, metadata);

    expect(normalised.mimeType).toBe('image/gif');
    expect(normalised.body.equals(gif)).toBe(true);
  });
});
