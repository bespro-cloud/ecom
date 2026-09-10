import { BACKOFF_MAX_MS, computeBackoff, dlqName } from './queue.constants.js';

describe('computeBackoff', () => {
  const noJitter = () => 0.5;

  it('grows exponentially from a five-second base', () => {
    expect(computeBackoff(1, noJitter)).toBe(5_000);
    expect(computeBackoff(2, noJitter)).toBe(10_000);
    expect(computeBackoff(3, noJitter)).toBe(20_000);
    expect(computeBackoff(4, noJitter)).toBe(40_000);
  });

  it('caps the delay so a job is not deferred for hours', () => {
    expect(computeBackoff(50, noJitter)).toBe(BACKOFF_MAX_MS);
  });

  it('never returns a delay below one second', () => {
    expect(computeBackoff(0, () => 0)).toBeGreaterThanOrEqual(1000);
    expect(computeBackoff(1, () => 0)).toBeGreaterThanOrEqual(1000);
  });

  it('applies jitter within ±25%, so a fleet does not retry in lockstep', () => {
    const delays = Array.from({ length: 200 }, () => computeBackoff(3));
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(50);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(20_000 * 0.75);
      expect(delay).toBeLessThanOrEqual(20_000 * 1.25);
    }
  });
});

describe('dlqName', () => {
  it('derives the dead-letter queue from the queue name', () => {
    expect(dlqName('email')).toBe('email-dlq');
    expect(dlqName('payments')).toBe('payments-dlq');
  });
});
