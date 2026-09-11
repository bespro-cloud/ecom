import { Inject, Injectable } from '@nestjs/common';
import { derivedKey, DEFAULT_RENDITIONS, type StorageProvider } from '@health/storage';
import { STORAGE_PROVIDER } from './storage.provider.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';

/**
 * Public URLs for stored media.
 *
 * Separate from the upload path because it is called on every catalogue read,
 * and building a URL must never touch the network. Rendition URLs are derived
 * from the source checksum alone — the same derivation the upload used — so no
 * lookup is needed to know where a resized image lives.
 */
@Injectable()
export class MediaUrlService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly config: AppConfigService,
  ) {}

  publicUrl(storageKey: string): string {
    return this.storage.publicUrl(storageKey);
  }

  /**
   * URLs for every generated size, keyed by rendition name.
   *
   * The storefront turns these into a `srcset`, so a phone downloads a 400px
   * image rather than a 1600px one.
   */
  renditions(checksum: string): Record<string, string> {
    const urls: Record<string, string> = {};
    for (const rendition of DEFAULT_RENDITIONS) {
      const extension = rendition.format === 'jpeg' ? '.jpg' : `.${rendition.format}`;
      urls[rendition.name] = this.storage.publicUrl(
        derivedKey(checksum, rendition.name, extension),
      );
    }
    return urls;
  }

  /** Widths matching the rendition names, for building a `srcset` descriptor. */
  renditionWidths(): Record<string, number> {
    return Object.fromEntries(
      DEFAULT_RENDITIONS.map((rendition) => [rendition.name, rendition.width]),
    );
  }

  /**
   * A time-limited URL for a private object.
   *
   * Compliance documents and certificates are not public: they are commercially
   * sensitive, and some carry supplier information. They are served through a
   * short-lived signed URL rather than a guessable path.
   */
  async signedUrl(storageKey: string): Promise<string> {
    return this.storage.signedReadUrl(storageKey, this.config.env.MEDIA_SIGNED_URL_TTL_SECONDS);
  }
}
