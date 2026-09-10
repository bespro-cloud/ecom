import { Global, Module } from '@nestjs/common';
import { systemClock, type Clock } from '@health/config';
import { AppConfigService } from './app-config.service.js';

export const CLOCK = Symbol('CLOCK');

/**
 * Configuration and the clock are the two things nearly every module needs and
 * neither should be re-created per module, so they are global.
 */
@Global()
@Module({
  providers: [
    { provide: AppConfigService, useFactory: () => new AppConfigService() },
    { provide: CLOCK, useValue: systemClock satisfies Clock },
  ],
  exports: [AppConfigService, CLOCK],
})
export class AppConfigModule {}
