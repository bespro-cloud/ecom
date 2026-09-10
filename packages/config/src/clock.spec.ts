import { describe, expect, it } from 'vitest';
import { addSeconds, FixedClock } from './clock.js';

describe('FixedClock', () => {
  it('does not move unless advanced', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('advances by milliseconds', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    clock.advance(90_000);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:30.000Z');
  });

  it('hands out copies so callers cannot mutate it', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
});

describe('addSeconds', () => {
  it('adds without mutating the input', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    expect(addSeconds(base, 60).toISOString()).toBe('2026-01-01T00:01:00.000Z');
    expect(base.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
