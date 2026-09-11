import sharp from 'sharp';
import { StorageError } from './types.js';

/**
 * Image inspection and rendition generation.
 *
 * Two jobs, and the first matters more than the second: an uploaded file is
 * only accepted as an image if a decoder can actually parse it. A file named
 * `.jpg` that is really an HTML document with a script tag is a stored XSS
 * waiting for someone to open it directly, and Content-Type alone does not stop
 * that — the uploader chooses it.
 */

export interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  mimeType: string;
  hasAlpha: boolean;
}

/** Formats we accept for upload. SVG is deliberately excluded — see below. */
const ACCEPTED_FORMATS: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

export class UnsupportedImageError extends Error {
  /**
   * The message is shown to whoever uploaded the file, so it never carries the
   * decoder's own wording — that can name internal libraries and versions. The
   * underlying failure goes on `cause` instead, where the log pipeline can pick
   * it up and a customer cannot.
   */
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnsupportedImageError';
  }
}

/**
 * Reads real dimensions and format from the bytes.
 *
 * SVG is rejected on upload: it is a document format that can carry script and
 * external references, and serving user-supplied SVG from the same origin as
 * the storefront is a straightforward XSS. Vector assets that genuinely need to
 * be SVG are added by a developer to the code, not uploaded through the admin.
 */
export async function inspectImage(body: Buffer): Promise<ImageMetadata> {
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(body, { failOn: 'error' }).metadata();
  } catch (error) {
    throw new UnsupportedImageError(
      'That file could not be read as an image. It may be corrupt, or not an image at all.',
      { cause: error },
    );
  }

  const format = metadata.format ?? '';
  const mimeType = ACCEPTED_FORMATS[format];
  if (!mimeType) {
    throw new UnsupportedImageError(
      `Images must be JPEG, PNG, WebP, AVIF or GIF. This file is ${format || 'an unrecognised format'}.`,
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new UnsupportedImageError('That image has no readable dimensions.');
  }

  return {
    width: metadata.width,
    height: metadata.height,
    format,
    mimeType,
    hasAlpha: metadata.hasAlpha === true,
  };
}

export interface Rendition {
  /** Short identifier used in the derived storage key. */
  name: string;
  width: number;
  format: 'webp' | 'avif' | 'jpeg';
}

/**
 * Renditions generated on upload.
 *
 * Widths match the breakpoints the storefront actually requests, so the browser
 * never downloads a 2400px original to display it at 400px. WebP because it is
 * universally supported and materially smaller than JPEG.
 */
export const DEFAULT_RENDITIONS: Rendition[] = [
  { name: 'thumb', width: 200, format: 'webp' },
  { name: 'small', width: 400, format: 'webp' },
  { name: 'medium', width: 800, format: 'webp' },
  { name: 'large', width: 1600, format: 'webp' },
];

export interface GeneratedRendition {
  name: string;
  body: Buffer;
  mimeType: string;
  width: number;
  height: number;
  extension: string;
}

/**
 * Produces a rendition.
 *
 * `withoutEnlargement` matters: upscaling a 300px source to 1600px produces a
 * larger file that looks worse. A source smaller than the target is returned at
 * its own size, and the caller records the real dimensions.
 */
export async function generateRendition(
  body: Buffer,
  rendition: Rendition,
): Promise<GeneratedRendition> {
  try {
    const pipeline = sharp(body, { failOn: 'error' })
      .rotate() // honour EXIF orientation, then drop the metadata
      .resize({ width: rendition.width, withoutEnlargement: true, fit: 'inside' });

    const output =
      rendition.format === 'webp'
        ? pipeline.webp({ quality: 82 })
        : rendition.format === 'avif'
          ? pipeline.avif({ quality: 60 })
          : pipeline.jpeg({ quality: 85, progressive: true, mozjpeg: true });

    const { data, info } = await output.toBuffer({ resolveWithObject: true });

    return {
      name: rendition.name,
      body: data,
      mimeType: `image/${rendition.format}`,
      width: info.width,
      height: info.height,
      extension: `.${rendition.format === 'jpeg' ? 'jpg' : rendition.format}`,
    };
  } catch (error) {
    throw new StorageError('could not generate image rendition', 'images', false, {
      cause: error,
    });
  }
}

/**
 * Re-encodes an upload, discarding everything that is not pixels.
 *
 * Camera and phone images carry EXIF that routinely includes GPS coordinates
 * and device identifiers. Publishing a product photo should not publish the
 * warehouse's location.
 */
export async function normaliseOriginal(
  body: Buffer,
  metadata: ImageMetadata,
): Promise<{ body: Buffer; mimeType: string; extension: string; width: number; height: number }> {
  // GIF may be animated; re-encoding would flatten it, so it is passed through.
  if (metadata.format === 'gif') {
    return {
      body,
      mimeType: metadata.mimeType,
      extension: '.gif',
      width: metadata.width,
      height: metadata.height,
    };
  }

  const pipeline = sharp(body, { failOn: 'error' }).rotate();
  const output = metadata.hasAlpha
    ? pipeline.png({ compressionLevel: 9 })
    : pipeline.jpeg({ quality: 90, progressive: true, mozjpeg: true });

  const { data, info } = await output.toBuffer({ resolveWithObject: true });
  return {
    body: data,
    mimeType: metadata.hasAlpha ? 'image/png' : 'image/jpeg',
    extension: metadata.hasAlpha ? '.png' : '.jpg',
    width: info.width,
    height: info.height,
  };
}
