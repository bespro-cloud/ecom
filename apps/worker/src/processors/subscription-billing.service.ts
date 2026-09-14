import { Inject, Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PinoLogger } from 'nestjs-pino';
import { parseServerEnv, type Clock, type ServerEnv } from '@health/config';
import { billSubscriptionPeriod, listDueSubscriptions, type BillingDeps } from '@health/database';
import { createPaymentProvider, type PaymentProvider } from '@health/payments';
import { PrismaService } from '../prisma.service.js';
import { CLOCK } from '../clock.module.js';

/**
 * The subscription billing run.
 *
 * This is the process that actually collects recurring payments: nothing else
 * in the system charges a renewal on a schedule. It takes the charge by calling
 * `billSubscriptionPeriod` in `@health/database` — the same function the API
 * calls when a subscription is first created or when staff retry a failed
 * renewal — so there is one implementation of taking money, covered by the
 * API's integration tests, rather than a second one here free to drift.
 *
 * The payment provider comes from `createPaymentProvider`, the same factory the
 * API binds, so the scheduled charge cannot land on a different adapter from
 * the one that charged the customer at checkout. `packages/config` refuses the
 * development adapter in production, so this run cannot silently pretend to
 * collect money.
 *
 * Four safety properties are worth stating.
 *
 * **Idempotent per period.** A `SubscriptionInvoice` is unique on
 * `(subscription, period start)` and is written before the provider is called,
 * so an overlapping run, a retry, or a crash between charging and recording
 * cannot produce a second charge for the same month.
 *
 * **Nothing is charged early.** `billSubscriptionPeriod` re-reads
 * `nextBillingAt` and refuses a subscription that is not yet due, so a
 * mistimed run — or this query being wrong — cannot pull a payment forward.
 *
 * **A cancelled or paused subscription cannot be selected.** Not because the
 * query filters them, though it does, but because a database CHECK refuses to
 * let a cancelled subscription hold a `next_billing_at` at all.
 *
 * **One bad card does not stop the run.** Every refusal comes back as a return
 * value; each subscription is billed in its own call, and a thrown error is
 * logged and the loop continues.
 *
 * Charges run one at a time rather than in parallel. A renewal run is not
 * latency-sensitive, and serial calls keep a burst of declines from looking to
 * the acquirer like card testing.
 *
 * Hourly. Renewals are dated in days; a run that fires sixty times more often
 * than the data changes is load, not diligence.
 */
@Injectable()
export class SubscriptionBillingService {
  private readonly env: ServerEnv;
  private readonly payments: PaymentProvider;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(SubscriptionBillingService.name);
    this.env = parseServerEnv();
    this.payments = createPaymentProvider(this.env);
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'subscription-billing' })
  async run(): Promise<void> {
    const due = await listDueSubscriptions(this.prisma, this.clock.now(), 500);
    if (due.length === 0) return;

    this.logger.info(
      { due: due.length, provider: this.payments.name, realMoney: this.payments.isRealMoney },
      'starting subscription billing run',
    );

    let charged = 0;
    let failed = 0;
    let skipped = 0;

    for (const subscriptionId of due) {
      try {
        const outcome = await billSubscriptionPeriod(this.deps(), { subscriptionId });
        if (outcome.charged) charged += 1;
        else if (outcome.reason === 'This subscription is not due yet.') skipped += 1;
        else failed += 1;
      } catch (error) {
        // A subscription that throws has already had its failure recorded by
        // `billSubscriptionPeriod` unless the throw came from the database
        // itself. Either way the run continues: one unreachable row must not
        // leave every other customer uncharged.
        failed += 1;
        this.logger.error({ err: error, subscriptionId }, 'subscription billing raised');
      }
    }

    this.logger.info({ charged, failed, skipped }, 'subscription billing run finished');
  }

  private deps(): BillingDeps {
    return {
      prisma: this.prisma,
      payments: this.payments,
      now: () => this.clock.now(),
      onEvent: (event) => {
        if (event.type === 'renewed') return;
        this.logger.warn(
          {
            subscriptionId: event.subscriptionId,
            attempts: event.attempts,
            code: event.code,
            exhausted: event.type === 'unpaid',
          },
          'subscription renewal failed',
        );
      },
      onError: (error, context) =>
        this.logger.error({ err: error, ...context }, 'subscription renewal raised'),
    };
  }
}
