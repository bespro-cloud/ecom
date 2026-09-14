import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { slugSchema } from '@health/validation';
import { Public } from '../../common/decorators/public.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import { ReviewsService } from './reviews/reviews.service.js';

/**
 * Published reviews, for the product page.
 *
 * Separate from the account controller because this is the one review route a
 * signed-out visitor may call, and separating it makes the exposure obvious
 * rather than a decorator to overlook in a list of authenticated handlers.
 *
 * `publishedForSlug` filters to `PUBLISHED` inside the query — for the product
 * as well as the reviews — so no argument reaches this route that could widen
 * it to moderation queue content.
 */
@ApiTags('Catalogue')
@Controller({ path: 'catalogue', version: '1' })
export class PublicReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Get('products/:slug/reviews')
  @Public()
  @ApiOperation({
    summary: 'Published reviews for a listing, with the rating summary',
    description:
      'Only reviews a moderator approved. The average is computed over the same set, so unmoderated text cannot influence the number shown on the page.',
  })
  async forProduct(@Param('slug', new ZodValidationPipe(slugSchema)) slug: string) {
    return this.reviews.publishedForSlug(slug);
  }
}
