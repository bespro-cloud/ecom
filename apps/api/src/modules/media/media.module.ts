import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { AppConfigService } from '../../infrastructure/config/app-config.service.js';
import { MediaService } from './media.service.js';
import { MediaUrlService } from './media-url.service.js';
import { MediaController } from './media.controller.js';

@Module({
  imports: [
    MulterModule.registerAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        // In memory, not on disk: the file is inspected, re-encoded and pushed
        // to object storage, so it never needs a filesystem path — and a
        // temp-file path is one more thing to clean up and to get wrong.
        storage: memoryStorage(),
        limits: {
          fileSize: config.env.MEDIA_MAX_UPLOAD_BYTES,
          files: 1,
          // Bounds the multipart parser itself, so a malformed request cannot
          // consume memory before the size limit is reached.
          fields: 10,
          parts: 12,
        },
      }),
    }),
  ],
  controllers: [MediaController],
  providers: [MediaService, MediaUrlService],
  exports: [MediaService, MediaUrlService],
})
export class MediaModule {}
