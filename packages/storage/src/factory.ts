import type { ServerEnv } from '@health/config';
import { FilesystemStorageProvider } from './filesystem-provider.js';
import { S3StorageProvider } from './s3-provider.js';
import type { StorageProvider } from './types.js';

/**
 * Selects the configured storage adapter.
 *
 * As with email and payments, a development-only adapter is never a silent
 * fallback: an unimplemented provider throws rather than quietly writing
 * customer-visible assets somewhere they will not survive a deploy.
 */
export function createStorageProvider(env: ServerEnv): StorageProvider {
  switch (env.STORAGE_PROVIDER) {
    case 's3': {
      if (!env.S3_BUCKET) {
        throw new Error('STORAGE_PROVIDER=s3 requires S3_BUCKET to be set.');
      }
      return new S3StorageProvider({
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
        ...(env.S3_ACCESS_KEY ? { accessKeyId: env.S3_ACCESS_KEY } : {}),
        ...(env.S3_SECRET_KEY ? { secretAccessKey: env.S3_SECRET_KEY } : {}),
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        ...(env.MEDIA_PUBLIC_BASE_URL ? { publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL } : {}),
      });
    }
    case 'filesystem':
      return new FilesystemStorageProvider({
        root: env.STORAGE_FILESYSTEM_ROOT,
        baseUrl: env.MEDIA_PUBLIC_BASE_URL ?? `${env.API_PUBLIC_URL}/api/v1/media/files`,
        signingKey: env.SESSION_SECRET,
      });
    default:
      throw new Error(
        `STORAGE_PROVIDER="${env.STORAGE_PROVIDER}" is declared in configuration but no adapter is implemented.`,
      );
  }
}
