import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { FeatureFlagsService } from './feature-flags.service.js';
import { SettingsController } from './settings.controller.js';

@Global()
@Module({
  controllers: [SettingsController],
  providers: [SettingsService, FeatureFlagsService],
  exports: [SettingsService, FeatureFlagsService],
})
export class SettingsModule {}
