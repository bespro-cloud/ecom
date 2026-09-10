/**
 * Time abstraction.
 *
 * Session expiry, token TTLs, lockout windows and audit timestamps all depend
 * on "now". Injecting it keeps those paths deterministic under test instead of
 * relying on sleeps.
 */
export interface Clock {
  now(): Date;
  /** Milliseconds since epoch. */
  timestamp(): number;
}

export const systemClock: Clock = {
  now: () => new Date(),
  timestamp: () => Date.now(),
};

export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  timestamp(): number {
    return this.current.getTime();
  }

  set(date: Date): void {
    this.current = date;
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}
