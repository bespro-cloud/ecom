import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { checksumOf } from './keys.js';
import {
  ObjectNotFoundError,
  StorageError,
  type PutObjectInput,
  type StorageProvider,
  type StoredObject,
} from './types.js';

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** Set for MinIO, Cloudflare R2 or any other S3-compatible endpoint. */
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Required by MinIO and most self-hosted stores. */
  forcePathStyle?: boolean;
  /** CDN origin for public objects. Falls back to the S3 URL. */
  publicBaseUrl?: string;
}

/**
 * The production storage adapter.
 *
 * This is not a mock with a different name: it speaks the S3 protocol and works
 * unchanged against AWS S3, MinIO, Cloudflare R2 or any other S3-compatible
 * store. Local development points it at MinIO; production points it at whatever
 * the deployment uses. The integration tests run it against a real S3 protocol
 * server, so the code path under test is the one that runs in production.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  readonly bucket: string;

  private readonly client: S3Client;
  private readonly publicBaseUrl: string | null;

  constructor(private readonly options: S3StorageOptions) {
    this.bucket = options.bucket;
    this.publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '') ?? null;

    const config: S3ClientConfig = {
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      ...(options.forcePathStyle !== undefined ? { forcePathStyle: options.forcePathStyle } : {}),
      ...(options.accessKeyId && options.secretAccessKey
        ? {
            credentials: {
              accessKeyId: options.accessKeyId,
              secretAccessKey: options.secretAccessKey,
            },
          }
        : {}),
    };
    this.client = new S3Client(config);
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const checksum = checksumOf(input.body);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.mimeType,
          ContentLength: input.body.byteLength,
          ...(input.cacheControl ? { CacheControl: input.cacheControl } : {}),
          // Kept alongside the object so an operator looking at the bucket can
          // tell what a content-addressed key actually is.
          Metadata: { checksum, ...(input.metadata ?? {}) },
        }),
      );
    } catch (error) {
      throw toStorageError(error, this.name, 'could not store object');
    }

    return {
      key: input.key,
      bucket: this.bucket,
      sizeBytes: input.body.byteLength,
      mimeType: input.mimeType,
      checksum,
    };
  }

  async get(key: string): Promise<Buffer> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) throw new ObjectNotFoundError(key, this.name);
      const bytes = await response.Body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (error) {
      if (isNotFound(error)) throw new ObjectNotFoundError(key, this.name);
      throw toStorageError(error, this.name, 'could not read object');
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw toStorageError(error, this.name, 'could not stat object');
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      // S3 delete is idempotent; a missing key is success, not a failure.
      if (isNotFound(error)) return;
      throw toStorageError(error, this.name, 'could not delete object');
    }
  }

  async signedReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    if (expiresInSeconds <= 0 || expiresInSeconds > 7 * 24 * 60 * 60) {
      // S3 caps presigned URLs at seven days; a longer request is a mistake
      // that would otherwise fail confusingly at request time.
      throw new RangeError('expiresInSeconds must be between 1 second and 7 days');
    }
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  publicUrl(key: string): string {
    if (this.publicBaseUrl) return `${this.publicBaseUrl}/${key}`;
    if (this.options.endpoint) {
      const base = this.options.endpoint.replace(/\/+$/, '');
      return this.options.forcePathStyle
        ? `${base}/${this.bucket}/${key}`
        : `${base.replace('://', `://${this.bucket}.`)}/${key}`;
    }
    return `https://${this.bucket}.s3.${this.options.region}.amazonaws.com/${key}`;
  }

  async verifyConfiguration(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      throw new StorageError(
        `Bucket "${this.bucket}" is not reachable. Check the endpoint, credentials and that the bucket exists.`,
        this.name,
        false,
        { cause: error },
      );
    }
  }

  /** Releases sockets. Called on shutdown. */
  destroy(): void {
    this.client.destroy();
  }
}

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

function toStorageError(error: unknown, provider: string, message: string): StorageError {
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata
    ?.httpStatusCode;
  // 5xx and throttling are worth retrying; a 4xx means the request itself is
  // wrong and retrying just repeats the mistake.
  const retryable = status === undefined || status >= 500 || status === 429;
  return new StorageError(message, provider, retryable, { cause: error });
}
