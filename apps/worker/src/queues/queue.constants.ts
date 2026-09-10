import { QUEUE_NAMES, type QueueName } from '@health/types';

export { QUEUE_NAMES };
export type { QueueName };

/**
 * Retry policy.
 *
 * Exponential backoff with jitter: five attempts spread over roughly ten
 * minutes. Without jitter a burst of jobs that fail together (a provider
 * outage) would retry in lockstep and hammer the provider the moment it
 * recovers.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'custom' as const },
  removeOnComplete: { age: 24 * 60 * 60, count: 5000 },
  // Failures are kept longer than successes: they are the ones worth reading.
  removeOnFail: { age: 14 * 24 * 60 * 60 },
};

export const BACKOFF_BASE_MS = 5_000;
export const BACKOFF_MAX_MS = 10 * 60 * 1000;

/**
 * `attemptsMade` is 1-based on the first retry.
 * 5s, 10s, 20s, 40s ... each with up to ±25% jitter, capped at ten minutes.
 */
export function computeBackoff(attemptsMade: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    BACKOFF_BASE_MS * 2 ** Math.max(attemptsMade - 1, 0),
    BACKOFF_MAX_MS,
  );
  const jitter = exponential * 0.25 * (random() * 2 - 1);
  return Math.max(1000, Math.round(exponential + jitter));
}

/** Dead-letter queue name for a queue. BullMQ forbids ':' in queue names. */
export function dlqName(queue: QueueName): string {
  return `${queue}-dlq`;
}

/**
 * BullMQ key prefix.
 *
 * Derived from REDIS_KEY_PREFIX rather than hard-coded, so two environments
 * pointed at the same Redis instance (a shared staging cluster, or a developer
 * running the test suite while the dev worker is up) do not consume each
 * other's jobs.
 */
export function queuePrefix(redisKeyPrefix: string): string {
  return `${redisKeyPrefix}:q`;
}
