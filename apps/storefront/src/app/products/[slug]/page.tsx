import type { Metadata } from 'next';
import Link from 'next/link';
import { ApiError } from '@/lib/api-client';
import { redirectOrNotFound } from '@/lib/redirects';
import { fetchProduct, type ProductDetail } from '@/lib/catalogue';
import { publicConfig } from '@/lib/env';
import { formatMoney } from '@/lib/format';
import { BreadcrumbStructuredData, ProductStructuredData } from '@/components/structured-data';
import { ProductGallery } from '@/components/product-gallery';
import { AddToCart } from '@/components/add-to-cart';
import { ProductReviews } from '@/components/product-reviews';
import { TrackProductView } from '@/components/analytics';
import { fetchProductReviews } from '@/lib/lifecycle';
import { currentUser } from '@/lib/session';

async function load(slug: string): Promise<ProductDetail> {
  try {
    return await fetchProduct(slug);
  } catch (error) {
    // A withdrawn listing is a 404 to a customer, not an error page. The
    // distinction matters: any other failure must still be loud.
    //
    // Before giving up, ask whether the listing simply moved. A product that
    // has been indexed for two years and silently starts 404ing after a rename
    // loses its ranking and the people who bookmarked it.
    if (error instanceof ApiError && error.status === 404) {
      await redirectOrNotFound(`/products/${slug}`);
    }
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const product = await load(slug);

  return {
    title: product.seo.title,
    description: product.seo.description ?? product.shortDescription ?? undefined,
    alternates: { canonical: product.seo.canonicalUrl ?? `/products/${product.slug}` },
    // Honoured rather than ignored: an editor marking a listing noindex has a
    // reason, and the storefront is the only place that can act on it.
    robots: product.seo.noindex ? { index: false, follow: true } : undefined,
    openGraph: {
      type: 'website',
      title: product.seo.ogTitle ?? product.seo.title,
      description: product.seo.ogDescription ?? product.seo.description ?? undefined,
      images: product.images.slice(0, 1).map((image) => ({ url: image.url, alt: image.altText })),
    },
  };
}

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Reviews are fetched alongside the listing rather than after it: they are
  // part of the page, and a second waterfall would delay the whole render.
  const [product, reviews, user] = await Promise.all([
    load(slug),
    fetchProductReviews(slug),
    currentUser(),
  ]);
  const url = `${publicConfig.siteUrl}/products/${product.slug}`;

  const trail = [
    { name: 'Products', path: '/products' },
    ...product.breadcrumbs.map((entry) => ({
      name: entry.name,
      path: `/categories/${entry.slug}`,
    })),
    { name: product.name, path: `/products/${product.slug}` },
  ];

  const active = product.ingredients.filter((entry) => entry.isActive);
  const other = product.ingredients.filter((entry) => !entry.isActive);
  const onOffer =
    product.compareAtPriceCents !== null && product.compareAtPriceCents > product.priceCents;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <TrackProductView productId={product.id} />
      <ProductStructuredData product={product} url={url} />
      <BreadcrumbStructuredData trail={trail} siteUrl={publicConfig.siteUrl} />

      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <ol className="flex flex-wrap items-center gap-1">
          {trail.map((entry, index) => (
            <li key={entry.path} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              {index === trail.length - 1 ? (
                <span aria-current="page" className="text-slate-700">
                  {entry.name}
                </span>
              ) : (
                <Link href={entry.path} className="hover:text-slate-700 hover:underline">
                  {entry.name}
                </Link>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="mt-6 grid gap-10 lg:grid-cols-2">
        <ProductGallery images={product.images} productName={product.name} />

        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-brand-700">
            {product.typeLabel}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
            {product.name}
          </h1>
          {product.brand ? <p className="mt-1 text-sm text-slate-600">{product.brand}</p> : null}

          <p className="mt-4 text-2xl font-semibold text-slate-900">
            {formatMoney(product.priceCents, product.currency)}
            {onOffer ? (
              <span className="ml-2 text-base font-normal text-slate-500 line-through">
                {formatMoney(product.compareAtPriceCents!, product.currency)}
              </span>
            ) : null}
          </p>

          {product.shortDescription ? (
            <p className="mt-4 text-base leading-relaxed text-slate-700">
              {product.shortDescription}
            </p>
          ) : null}

          <div className="mt-6">
            <AddToCart
              variantId={product.variants[0]?.id ?? ''}
              productId={product.id}
              availableQuantity={product.availableQuantity ?? null}
            />
          </div>

          {product.allergens.length > 0 ? (
            <section
              aria-labelledby="allergens-heading"
              className="mt-6 rounded-lg border-l-4 border-amber-500 bg-amber-50 p-4"
            >
              <h2 id="allergens-heading" className="text-sm font-semibold text-amber-900">
                Allergen information
              </h2>
              <p className="mt-1 text-sm text-amber-900">
                Contains: {product.allergens.join(', ')}.
              </p>
            </section>
          ) : null}

          {product.warnings.length > 0 ? (
            <section aria-labelledby="warnings-heading" className="mt-6">
              <h2 id="warnings-heading" className="text-sm font-semibold text-slate-900">
                Warnings
              </h2>
              <ul className="mt-2 space-y-2">
                {product.warnings.map((warning, index) => (
                  <li
                    key={`${warning.text}-${index}`}
                    className={`rounded-lg p-3 text-sm ${
                      warning.severity === 'DANGER'
                        ? 'bg-red-50 text-red-900'
                        : 'bg-slate-100 text-slate-800'
                    }`}
                  >
                    <span className="font-medium">{warning.audienceLabel}: </span>
                    {warning.text}
                    {warning.source ? (
                      <span className="mt-1 block text-xs text-slate-600">
                        From the ingredient record for {warning.source}.
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-slate-200 pt-4 text-sm">
            <dt className="text-slate-500">SKU</dt>
            <dd className="text-slate-800">{product.sku}</dd>
            {product.manufacturer ? (
              <>
                <dt className="text-slate-500">Manufacturer</dt>
                <dd className="text-slate-800">{product.manufacturer}</dd>
              </>
            ) : null}
            {product.countryOfOrigin ? (
              <>
                <dt className="text-slate-500">Country of origin</dt>
                <dd className="text-slate-800">{product.countryOfOrigin}</dd>
              </>
            ) : null}
            {product.weightGrams !== null ? (
              <>
                <dt className="text-slate-500">Net weight</dt>
                <dd className="text-slate-800">{product.weightGrams} g</dd>
              </>
            ) : null}
          </dl>
        </div>
      </div>

      {product.longDescription ? (
        <section aria-labelledby="about-heading" className="mt-12 max-w-prose">
          <h2 id="about-heading" className="text-xl font-semibold text-slate-900">
            About this product
          </h2>
          {/*
            Rendered as paragraphs of plain text. The description is stored as
            text and is never interpreted as markup, so a pasted script tag is
            shown as characters rather than executed.
          */}
          {product.longDescription.split(/\n{2,}/).map((paragraph, index) => (
            <p key={index} className="mt-3 text-base leading-relaxed text-slate-700">
              {paragraph}
            </p>
          ))}
        </section>
      ) : null}

      {active.length > 0 ? (
        <IngredientTable title="Active ingredients" entries={active} showAmounts />
      ) : null}
      {other.length > 0 ? (
        <IngredientTable title="Other ingredients" entries={other} showAmounts={false} />
      ) : null}

      {product.claims.length > 0 ? (
        <section aria-labelledby="claims-heading" className="mt-12 max-w-prose">
          <h2 id="claims-heading" className="text-xl font-semibold text-slate-900">
            What this product is for
          </h2>
          {/*
            Every statement here was individually approved by a named compliance
            reviewer against recorded evidence, and this renders the exact
            wording that was signed off — never a draft and never a revision in
            progress. A claim whose approval has lapsed disappears from this
            list rather than lingering.
          */}
          <ul className="mt-3 space-y-2">
            {product.claims.map((claim, index) => (
              <li
                key={index}
                className="rounded-lg bg-white p-4 text-base leading-relaxed text-slate-800 ring-1 ring-slate-200"
              >
                {claim.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ProductReviews slug={product.slug} data={reviews} canWrite={user !== null} />

      {product.disclaimers.length > 0 ? (
        <section aria-labelledby="disclaimers-heading" className="mt-12 max-w-prose">
          <h2 id="disclaimers-heading" className="sr-only">
            Required disclaimers
          </h2>
          <div className="space-y-3 rounded-xl bg-white p-5 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200">
            {product.disclaimers.map((disclaimer) => (
              <p key={disclaimer.kind}>{disclaimer.text}</p>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function IngredientTable({
  title,
  entries,
  showAmounts,
}: {
  title: string;
  entries: ProductDetail['ingredients'];
  showAmounts: boolean;
}) {
  const id = title.toLowerCase().replace(/\s+/g, '-');

  return (
    <section aria-labelledby={id} className="mt-12">
      <h2 id={id} className="text-xl font-semibold text-slate-900">
        {title}
      </h2>
      <div className="mt-4 overflow-x-auto rounded-xl bg-white ring-1 ring-slate-200">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <caption className="sr-only">
            {title}, with amounts per serving and sourcing where recorded.
          </caption>
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                Ingredient
              </th>
              {showAmounts ? (
                <>
                  <th scope="col" className="px-4 py-3 font-medium">
                    Amount
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    % Daily Value
                  </th>
                </>
              ) : null}
              <th scope="col" className="px-4 py-3 font-medium">
                Source
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {entries.map((entry) => (
              <tr key={entry.slug}>
                <th scope="row" className="px-4 py-3 text-left font-normal">
                  <Link
                    href={`/ingredients/${entry.slug}`}
                    className="font-medium text-slate-900 hover:underline"
                  >
                    {entry.name}
                  </Link>
                  {entry.isAllergen ? (
                    <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                      Allergen
                    </span>
                  ) : null}
                  {entry.scientificName ? (
                    <span className="block text-xs italic text-slate-500">
                      {entry.scientificName}
                    </span>
                  ) : null}
                  {entry.notes ? (
                    <span className="block text-xs text-slate-500">{entry.notes}</span>
                  ) : null}
                </th>
                {showAmounts ? (
                  <>
                    <td className="px-4 py-3 text-slate-700">
                      {entry.amount !== null ? `${entry.amount} ${entry.unit ?? ''}`.trim() : '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      {/*
                        A missing Daily Value is shown as "Not established",
                        which is what a facts panel says. Writing 0% or leaving
                        it blank would both read as a claim we have not made.
                      */}
                      {entry.dailyValuePercent !== null
                        ? `${entry.dailyValuePercent}%`
                        : 'Not established'}
                    </td>
                  </>
                ) : null}
                <td className="px-4 py-3 text-slate-700">
                  {entry.sources.length > 0
                    ? entry.sources
                        .map((source) =>
                          [
                            source.type.toLowerCase().replace(/_/g, ' '),
                            source.originCountry,
                            source.isVegan ? 'vegan' : source.isVegetarian ? 'vegetarian' : null,
                          ]
                            .filter(Boolean)
                            .join(', '),
                        )
                        .join('; ')
                    : 'Not recorded'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
