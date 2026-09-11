/**
 * Object storage contracts.
 *
 * Binary content — product images, labels, certificates, compliance evidence —
 * never goes in PostgreSQL. It goes here, and the database keeps the key.
 */

export interface StoredObject {
  key: string;
  bucket: string;
  sizeBytes: number;
  mimeType: string;
  /** SHA-256 of the bytes. Makes a repeat upload a no-op rather than a copy. */
  checksum: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  mimeType: string;
  /**
   * Cache lifetime for a CDN and the browser. Content-addressed keys can be
   * cached indefinitely because a changed file gets a different key.
   */
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface StorageProvider {
  readonly name: string;
  readonly bucket: string;

  put(input: PutObjectInput): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;

  /**
   * A time-limited URL for reading a private object.
   *
   * Used for compliance documents and anything else that must not be publicly
   * readable. Public product images are served through the CDN instead.
   */
  signedReadUrl(key: string, expiresInSeconds: number): Promise<string>;

  /** Public URL, for objects in a bucket fronted by a CDN. */
  publicUrl(key: string): string;

  /** Confirms the bucket exists and is writable. Called at boot. */
  verifyConfiguration(): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'StorageError';
    if (options?.cause) this.cause = options.cause;
  }
}

export class ObjectNotFoundError extends StorageError {
  constructor(key: string, provider: string) {
    super(`No object at key "${key}"`, provider, false);
    this.name = 'ObjectNotFoundError';
  }
}
