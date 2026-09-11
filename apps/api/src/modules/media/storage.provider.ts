import { Global, Module } from '@nestjs/common';
import { createStorageProvider, type StorageProvider } from '@health/storage';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

/**
 * One storage client for the process.
 *
 * Constructed from validated configuration, so an unreachable bucket or a
 * provider with no adapter fails at boot rather than on the first upload —
 * which would otherwise be discovered by whoever was adding a product.
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): StorageProvider => createStorageProvider(config.env),
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
