import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { checksumOf } from './keys.js';
import {
  ObjectNotFoundError,
  StorageError,
  type PutObjectInput,
  type StorageProvider,
  type StoredObject,
} from './types.js';

/**
 * Local filesystem adapter, for development without an object store running.
 *
 * It is a development convenience, not a production option: the environment
 * contract refuses to boot production with it, exactly as it does for the
 * console email provider. It exists so a new contributor can run the platform
 * with `pnpm dev` and nothing else.
 *
 * Signed URLs are genuinely signed (HMAC over key and expiry) so the API's
 * verification path is exercised in development rather than stubbed.
 */
export class FilesystemStorageProvider implements StorageProvider {
  readonly name = 'filesystem';
  readonly bucket: string;

  private readonly root: string;
  private readonly signingKey: Buffer;
  private readonly baseUrl: string;

  constructor(options: { root: string; bucket?: string; baseUrl: string; signingKey?: string }) {
    this.root = resolve(options.root);
    this.bucket = options.bucket ?? 'local';
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.signingKey = Buffer.from(options.signingKey ?? randomBytes(32).toString('hex'), 'utf8');
  }

  async put(input: PutObjectInput): Promise<StoredObject> {
    const path = this.pathFor(input.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.body);
    // The MIME type is not recoverable from the bytes, and the extension is not
    // authoritative, so it is stored beside the object.
    await writeFile(`${path}.meta.json`, JSON.stringify({ mimeType: input.mimeType }), 'utf8');

    return {
      key: input.key,
      bucket: this.bucket,
      sizeBytes: input.body.byteLength,
      mimeType: input.mimeType,
      checksum: checksumOf(input.body),
    };
  }

  async get(key: string): Promise<Buffer> {
    // Resolved outside the try: a key that escapes the root is a rejected
    // input, and must not be reported as a retryable read failure.
    const path = this.pathFor(key);
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ObjectNotFoundError(key, this.name);
      }
      throw new StorageError('could not read object', this.name, true, { cause: error });
    }
  }

  async exists(key: string): Promise<boolean> {
    const path = this.pathFor(key);
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    await rm(path, { force: true });
    await rm(`${path}.meta.json`, { force: true });
  }

  async signedReadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = this.sign(key, expiresAt);
    const params = new URLSearchParams({ expires: String(expiresAt), signature });
    return `${this.baseUrl}/${key}?${params.toString()}`;
  }

  /** Counterpart of `signedReadUrl`, used by the local file-serving route. */
  verifySignature(key: string, expires: string, signature: string): boolean {
    const expiresAt = Number(expires);
    if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;

    const expected = Buffer.from(this.sign(key, expiresAt), 'utf8');
    const supplied = Buffer.from(signature, 'utf8');
    if (expected.length !== supplied.length) return false;
    return timingSafeEqual(expected, supplied);
  }

  publicUrl(key: string): string {
    return `${this.baseUrl}/${key}`;
  }

  async verifyConfiguration(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const probe = join(this.root, '.write-probe');
    try {
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
    } catch (error) {
      throw new StorageError(`Storage root "${this.root}" is not writable.`, this.name, false, {
        cause: error,
      });
    }
  }

  private sign(key: string, expiresAt: number): string {
    return createHmac('sha256', this.signingKey).update(`${key}:${expiresAt}`).digest('hex');
  }

  /**
   * Resolves a key to a path inside the root, refusing anything that escapes
   * it. A key reaching this layer has already been derived from a checksum, but
   * a path-traversal check on a filesystem write is not something to leave to
   * an upstream invariant.
   */
  private pathFor(key: string): string {
    if (key.includes('\0')) throw new RangeError('key must not contain a null byte');
    const candidate = resolve(this.root, key);
    if (candidate !== this.root && !candidate.startsWith(this.root + sep)) {
      throw new RangeError(`key "${key}" resolves outside the storage root`);
    }
    return candidate;
  }
}
