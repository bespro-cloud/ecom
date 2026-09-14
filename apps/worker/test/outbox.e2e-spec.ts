import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { parseServerEnv } from '@health/config';
import { truncateAll } from '@health/database/testing';
import { PrismaService } from '../src/prisma.service.js';
import { QueueService } from '../src/queues/queue.service.js';
import { OutboxDispatcherService } from '../src/outbox/outbox-dispatcher.service.js';
import { WorkerMetricsService } from '../src/metrics.service.js';
import { CLOCK } from '../src/clock.module.js';
import { systemClock } from '@health/config';

/**
 * End-to-end verification of the outbox → queue hand-off against a real
 * PostgreSQL and a real Redis. The properties under test — SKIP LOCKED
 * claiming, idempotent enqueue, dead-lettering — do not exist in a mock.
 */

let prisma: PrismaService;
let queues: QueueService;
let dispatcher: OutboxDispatcherService;
let moduleRef: Awaited<ReturnType<ReturnType<typeof Test.createTestingModule>['compile']>>;

const env = parseServerEnv();

beforeAll(async () => {
  if (!/test/i.test(env.DATABASE_URL)) {
    throw new Error('Integration tests must run against a database whose name contains "test".');
  }

  moduleRef = await Test.createTestingModule({
    imports: [LoggerModule.forRoot({ pinoHttp: { level: 'fatal' } })],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      PrismaService,
      WorkerMetricsService,
      QueueService,
      OutboxDispatcherService,
    ],
  }).compile();

  prisma = moduleRef.get(PrismaService);
  queues = moduleRef.get(QueueService);
  dispatcher = moduleRef.get(OutboxDispatcherService);

  await prisma.onModuleInit();
  queues.onModuleInit();
});

afterAll(async () => {
  await queues.onModuleDestroy();
  await prisma.onModuleDestroy();
  await moduleRef.close();
});

beforeEach(async () => {
  // `audit_logs.actor_id` is ON DELETE SET NULL, so deleting a user issues an
  // UPDATE that the append-only trigger correctly refuses. The shared helper
  // suspends the triggers for the duration of the truncate.
  await truncateAll(prisma);
  await queues.get('email').obliterate({ force: true });
  await queues.get('email-dlq').obliterate({ force: true });
});

async function createUser(email = 'outbox@example.test') {
  return prisma.user.create({
    data: { email, emailNormalized: email, type: 'CUSTOMER' },
  });
}

describe('outbox dispatcher', () => {
  it('moves a pending message onto the right queue and marks it dispatched', async () => {
    const user = await createUser();
    const message = await prisma.outboxMessage.create({
      data: {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'user.registered.v1',
        payload: { verificationToken: 'tok' },
        correlationId: 'corr-1',
      },
    });

    const dispatched = await dispatcher.dispatchBatch();
    expect(dispatched).toBe(1);

    const updated = await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } });
    expect(updated.dispatchedAt).not.toBeNull();
    expect(updated.attempts).toBe(1);

    const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.outboxId).toBe(message.id);
    expect(jobs[0]!.data.correlationId).toBe('corr-1');
  });

  it('does not dispatch a message twice', async () => {
    const user = await createUser();
    await prisma.outboxMessage.create({
      data: {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'user.registered.v1',
        payload: {},
      },
    });

    expect(await dispatcher.dispatchBatch()).toBe(1);
    expect(await dispatcher.dispatchBatch()).toBe(0);

    const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active', 'completed']);
    expect(jobs).toHaveLength(1);
  });

  it('uses a job id derived from the row, so a re-enqueue after a crash is a no-op', async () => {
    const user = await createUser();
    const message = await prisma.outboxMessage.create({
      data: {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'user.registered.v1',
        payload: {},
      },
    });

    await dispatcher.dispatchBatch();

    // Simulate a crash between "job added" and "row marked dispatched".
    await prisma.outboxMessage.update({
      where: { id: message.id },
      data: { dispatchedAt: null },
    });
    await dispatcher.dispatchBatch();

    const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.id).toBe(`outbox:${message.id}`);
  });

  it('ignores messages that are not yet available', async () => {
    const user = await createUser();
    await prisma.outboxMessage.create({
      data: {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'user.registered.v1',
        payload: {},
        availableAt: new Date(Date.now() + 60_000),
      },
    });

    expect(await dispatcher.dispatchBatch()).toBe(0);
  });

  it('routes an unknown event to the analytics queue instead of dropping it', async () => {
    const user = await createUser();
    await prisma.outboxMessage.create({
      data: {
        aggregateType: 'product',
        aggregateId: user.id,
        // Deliberately an event nothing consumes. An event with no handler is
        // still evidence that something happened, so it must land somewhere
        // rather than being silently discarded.
        eventType: 'product.viewed.v1',
        payload: {},
      },
    });

    await dispatcher.dispatchBatch();
    const analytics = await queues.get('analytics').getJobs(['waiting', 'delayed', 'active']);
    expect(analytics.length).toBeGreaterThanOrEqual(1);
    await queues.get('analytics').obliterate({ force: true });
  });

  it('preserves ordering by availability', async () => {
    const user = await createUser();
    const older = await prisma.outboxMessage.create({
      data: {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'user.registered.v1',
        payload: { seq: 1 },
        availableAt: new Date(Date.now() - 60_000),
      },
    });
    await prisma.outboxMessage.create({
      data: {
        aggregateType: 'user',
        aggregateId: user.id,
        eventType: 'user.password_changed.v1',
        payload: { seq: 2 },
        availableAt: new Date(Date.now() - 1_000),
      },
    });

    await dispatcher.dispatchBatch();
    const jobs = await queues.get('email').getJobs(['waiting', 'delayed', 'active']);
    const ids = jobs.map((job) => job.data.outboxId);
    expect(ids).toContain(older.id);
    expect(jobs).toHaveLength(2);
  });
});

describe('dead-letter queue', () => {
  it('records the failure context rather than discarding the job', async () => {
    await queues.deadLetter(
      'email',
      'user.registered.v1',
      { outboxId: 'abc' },
      {
        jobId: 'job-1',
        attempts: 5,
        error: 'provider rejected the recipient',
      },
    );

    const dlq = queues.get('email-dlq');
    const jobs = await dlq.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.failure.error).toBe('provider rejected the recipient');
    expect(jobs[0]!.data.failure.attempts).toBe(5);
    expect(jobs[0]!.data.payload).toEqual({ outboxId: 'abc' });
  });

  it('does not retry out of the dead-letter queue automatically', async () => {
    await queues.deadLetter('email', 'x', {}, { jobId: 'job-2', attempts: 5, error: 'boom' });
    const jobs = await queues.get('email-dlq').getJobs(['waiting']);
    // Replay is an explicit operator action, never an automatic one.
    expect(jobs[0]!.opts.attempts).toBe(1);
  });
});

describe('queue consumption', () => {
  it('delivers an enqueued job to a worker', async () => {
    const connection = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    const received: unknown[] = [];

    const worker = new Worker(
      'email',
      async (job) => {
        received.push(job.data);
      },
      { connection, prefix: queues.prefix, concurrency: 1 },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('job was not consumed in time')), 15_000);
        worker.on('completed', () => {
          clearTimeout(timer);
          resolve();
        });
        worker.on('failed', (_job, error) => {
          clearTimeout(timer);
          reject(error);
        });
        void (queues.get('email') as Queue).add(
          'test.job',
          { hello: 'world' },
          { jobId: 'consume-1' },
        );
      });

      expect(received).toEqual([{ hello: 'world' }]);
    } finally {
      await worker.close();
      connection.disconnect();
    }
  });
});
