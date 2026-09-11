import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Clock } from '@health/config';
import {
  checksumOf,
  contentAddressedKey,
  DEFAULT_RENDITIONS,
  derivedKey,
  generateRendition,
  inspectImage,
  normaliseOriginal,
  UnsupportedImageError,
  type StorageProvider,
} from '@health/storage';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { CLOCK } from '../../infrastructure/config/config.module.js';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AuditService } from '../audit/audit.service.js';
import { CATALOGUE_AUDIT_ACTIONS } from '../catalogue/catalogue.audit.js';
import type { ActorContext } from '../rbac/roles.service.js';
import { STORAGE_PROVIDER } from './storage.provider.js';
import { MediaUrlService } from './media-url.service.js';

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface MediaView {
  id: string;
  kind: string;
  url: string;
  renditions: Record<string, string>;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  originalFilename: string | null;
  createdAt: string;
}

/**
 * Media ingestion.
 *
 * The order of operations matters and is not negotiable:
 *
 *  1. **Decode before trusting.** The declared MIME type is chosen by the
 *     uploader. A file is only an image if a decoder can parse it; anything
 *     else is rejected before it touches storage. A stored HTML document served
 *     from the media origin is XSS, and the Content-Type header would not have
 *     stopped it.
 *  2. **Re-encode the original**, which discards EXIF. Camera images routinely
 *     carry GPS coordinates; publishing a product photo should not publish the
 *     warehouse's location.
 *  3. **Address by content.** The storage key is the SHA-256 of the bytes, so
 *     re-uploading the same file costs nothing and creates no duplicate.
 *  4. **Write storage before the database row.** An orphaned object wastes a
 *     few kilobytes; a row pointing at an object that does not exist is a
 *     broken image on a live product page.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly audit: AuditService,
    private readonly urls: MediaUrlService,
    private readonly logger: PinoLogger,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(MediaService.name);
  }

  async uploadImage(file: UploadedFile, actor: ActorContext): Promise<MediaView> {
    this.assertWithinSizeLimit(file);

    let metadata;
    try {
      metadata = await inspectImage(file.buffer);
    } catch (error) {
      if (error instanceof UnsupportedImageError) {
        throw AppException.validation([{ path: 'file', message: error.message }]);
      }
      throw error;
    }

    const normalised = await normaliseOriginal(file.buffer, metadata);
    const checksum = checksumOf(normalised.body);

    // Content-addressed: the same file uploaded twice is the same row.
    const existing = await this.prisma.media.findFirst({
      where: { checksum, deletedAt: null },
    });
    if (existing) {
      this.logger.debug({ checksum }, 'identical media already stored; reusing it');
      return this.toView(existing);
    }

    const key = contentAddressedKey('products', checksum, normalised.extension);
    await this.storage.put({
      key,
      body: normalised.body,
      mimeType: normalised.mimeType,
      // Safe to cache forever: different content produces a different key.
      cacheControl: 'public, max-age=31536000, immutable',
    });

    await this.generateRenditions(normalised.body, checksum);

    const media = await this.prisma.$transaction(async (tx) => {
      const created = await tx.media.create({
        data: {
          kind: 'IMAGE',
          storageKey: key,
          bucket: this.storage.bucket,
          mimeType: normalised.mimeType,
          sizeBytes: normalised.body.byteLength,
          checksum,
          width: normalised.width,
          height: normalised.height,
          originalFilename: file.originalname.slice(0, 255),
          uploadedBy: actor.actorId,
        },
      });

      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.MEDIA_UPLOADED,
        entityType: 'media',
        entityId: created.id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        after: {
          checksum,
          mimeType: normalised.mimeType,
          sizeBytes: normalised.body.byteLength,
          dimensions: `${normalised.width}x${normalised.height}`,
        },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });

      return created;
    });

    this.logger.info({ mediaId: media.id, sizeBytes: media.sizeBytes, checksum }, 'image stored');
    return this.toView(media);
  }

  async findById(id: string): Promise<MediaView> {
    const media = await this.prisma.media.findFirst({ where: { id, deletedAt: null } });
    if (!media) throw AppException.notFound('Media');
    return this.toView(media);
  }

  async list(limit: number): Promise<MediaView[]> {
    const media = await this.prisma.media.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return media.map((entry) => this.toView(entry));
  }

  /**
   * Soft-deletes the row and leaves the object in place.
   *
   * Deleting the object would be wrong: keys are content-addressed, so another
   * media row — or a historical order's invoice — may reference the same bytes.
   * Reclaiming unreferenced objects is a separate, deliberate sweep.
   */
  async remove(id: string, actor: ActorContext): Promise<void> {
    const media = await this.prisma.media.findFirst({ where: { id, deletedAt: null } });
    if (!media) throw AppException.notFound('Media');

    const usage = await this.prisma.productImage.count({ where: { mediaId: id } });
    if (usage > 0) {
      throw AppException.conflict(
        `This image is used by ${usage} product image(s). Remove it from them first.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.media.update({ where: { id }, data: { deletedAt: this.clock.now() } });
      await this.audit.recordIn(tx, {
        action: CATALOGUE_AUDIT_ACTIONS.MEDIA_DELETED,
        entityType: 'media',
        entityId: id,
        actorId: actor.actorId,
        actorLabel: actor.actorLabel,
        before: { storageKey: media.storageKey, checksum: media.checksum },
        ipAddress: actor.ipAddress ?? null,
        userAgent: actor.userAgent ?? null,
        correlationId: actor.correlationId,
      });
    });
  }

  // -------------------------------------------------------------------------

  private assertWithinSizeLimit(file: UploadedFile): void {
    const limit = this.config.env.MEDIA_MAX_UPLOAD_BYTES;
    if (file.size > limit || file.buffer.byteLength > limit) {
      throw AppException.validation([
        {
          path: 'file',
          message: `Images must be ${Math.floor(limit / (1024 * 1024))} MB or smaller.`,
        },
      ]);
    }
    if (file.buffer.byteLength === 0) {
      throw AppException.validation([{ path: 'file', message: 'That file is empty.' }]);
    }
  }

  /**
   * Generates the resized variants.
   *
   * A rendition failing is logged but does not fail the upload: the original is
   * already stored and usable, and the storefront falls back to it. Losing the
   * upload because one resize failed would be a worse trade.
   */
  private async generateRenditions(body: Buffer, checksum: string): Promise<void> {
    await Promise.all(
      DEFAULT_RENDITIONS.map(async (rendition) => {
        try {
          const generated = await generateRendition(body, rendition);
          await this.storage.put({
            key: derivedKey(checksum, generated.name, generated.extension),
            body: generated.body,
            mimeType: generated.mimeType,
            cacheControl: 'public, max-age=31536000, immutable',
          });
        } catch (error) {
          this.logger.error(
            { err: error, checksum, rendition: rendition.name },
            'could not generate rendition; the original remains available',
          );
        }
      }),
    );
  }

  private toView(media: {
    id: string;
    kind: string;
    storageKey: string;
    checksum: string;
    mimeType: string;
    sizeBytes: number;
    width: number | null;
    height: number | null;
    originalFilename: string | null;
    createdAt: Date;
  }): MediaView {
    return {
      id: media.id,
      kind: media.kind,
      url: this.urls.publicUrl(media.storageKey),
      renditions: media.kind === 'IMAGE' ? this.urls.renditions(media.checksum) : {},
      mimeType: media.mimeType,
      sizeBytes: media.sizeBytes,
      width: media.width,
      height: media.height,
      originalFilename: media.originalFilename,
      createdAt: media.createdAt.toISOString(),
    };
  }
}
