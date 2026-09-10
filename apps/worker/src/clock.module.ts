import { Global, Module } from '@nestjs/common';
import { systemClock, type Clock } from '@health/config';

export const CLOCK = Symbol('CLOCK');

/**
 * The worker's clock, injected for the same reason as the API's: expiry
 * windows, retry schedules and housekeeping cut-offs must be controllable in
 * tests rather than depending on real elapsed time.
 */
@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock satisfies Clock }],
  exports: [CLOCK],
})
export class ClockModule {}
