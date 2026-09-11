import Link from 'next/link';
import type { ProductSummary } from '@/lib/catalogue';
import { formatMoney } from '@/lib/format';

/**
 * One product in a listing.
 *
 * Deliberately says almost nothing about what a product does. The card shows
 * what it is, what it costs and who makes it — a claim about an effect belongs
 * to a reviewed claim record, not to a grid tile.
 */
export function ProductCard({ product }: { product: ProductSummary }) {
  const image = product.image;
  const onOffer =
    product.compareAtPriceCents !== null && product.compareAtPriceCents > product.priceCents;

  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-xl bg-white ring-1 ring-slate-200 transition hover:ring-brand-300">
      <Link href={`/products/${product.slug}`} className="flex h-full flex-col">
        <div className="aspect-square overflow-hidden bg-slate-50">
          {image ? (
            // A plain <img>: media is served from a configurable
            // object-storage origin, which next/image would need allow-listed at
            // build time, and the renditions are already sized by the pipeline.
            <img
              src={image.renditions.medium ?? image.url}
              alt={image.altText}
              width={image.width ?? undefined}
              height={image.height ?? undefined}
              loading="lazy"
              className="h-full w-full object-cover transition group-hover:scale-[1.02]"
            />
          ) : (
            <div
              className="flex h-full w-full items-center justify-center text-sm text-slate-400"
              aria-hidden="true"
            >
              No photograph yet
            </div>
          )}
        </div>

        <div className="flex flex-1 flex-col gap-2 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            {product.typeLabel}
            {product.brand ? ` · ${product.brand}` : ''}
          </p>
          <h3 className="text-base font-semibold leading-snug text-slate-900">{product.name}</h3>
          {product.shortDescription ? (
            <p className="line-clamp-2 text-sm leading-relaxed text-slate-600">
              {product.shortDescription}
            </p>
          ) : null}

          <p className="mt-auto pt-2 text-base font-semibold text-slate-900">
            {formatMoney(product.priceCents, product.currency)}
            {onOffer ? (
              <>
                {' '}
                <span className="text-sm font-normal text-slate-500 line-through">
                  {formatMoney(product.compareAtPriceCents!, product.currency)}
                </span>
                <span className="sr-only"> was</span>
              </>
            ) : null}
          </p>
        </div>
      </Link>
    </article>
  );
}
