import { Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { PaymentsService } from './payments.service.js';

/**
 * Inbound payment webhooks.
 *
 * `@Public()`, because the provider has no session — but emphatically not
 * unauthenticated: every request is authenticated by its **signature**, which
 * is the only thing distinguishing the provider from anyone else who can reach
 * this URL. An unverified body here would let a stranger mark orders as paid.
 *
 * The raw body matters. Signatures are computed over exact bytes, so this
 * route is registered with a raw-body parser (see `bootstrap.ts`) and reads
 * `request.rawBody` rather than the parsed object — re-serialising JSON changes
 * whitespace and key order, and the signature with it.
 *
 * Always answers 200 for a verified event, including duplicates. A provider
 * that receives an error retries, so returning one for an event we have
 * already applied produces an infinite retry loop over work that is already
 * done.
 */
@ApiTags('Webhooks')
@Controller({ path: 'webhooks', version: '1' })
export class PaymentWebhooksController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('payments')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Payment provider webhook',
    description:
      'Verified by signature, deduplicated by the provider event id, then applied. Never trusts the body alone.',
  })
  @ApiExcludeEndpoint()
  async handle(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') stripeSignature?: string,
    @Headers('x-payment-signature') genericSignature?: string,
  ): Promise<{ received: true; duplicate: boolean }> {
    const raw = request.rawBody;
    if (!raw) {
      // Without the exact bytes there is nothing to verify against, and
      // guessing would defeat the whole mechanism.
      throw AppException.validation([
        { path: 'body', message: 'The webhook body could not be read.' },
      ]);
    }

    const signature = stripeSignature ?? genericSignature ?? '';
    const result = await this.payments.handleWebhook(raw.toString('utf8'), signature);

    return { received: true, duplicate: result.duplicate };
  }
}
