import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, apiRequest } from '@/lib/api-client';

/**
 * An ingredient reference page.
 *
 * These exist so a customer can look something up *before* buying, and so a
 * warning lives in one place rather than being copied onto every listing that
 * uses it. The page states what the ingredient is, where it is sourced from and
 * what warnings are attached to it — and nothing about what it does, because
 * that is a claim, and claims belong to a reviewed claim record.
 */

interface IngredientView {
  id: string;
  slug: string;
  name: string;
  scientificName: string | null;
  commonNames: string[];
  description: string | null;
  casNumber: string | null;
  allergen: string | null;
  isAllergen: boolean;
  sources: Array<{
    id: string;
    type: string;
    description: string | null;
    originCountry: string | null;
    supplier: string | null;
    isVegan: boolean;
    isVegetarian: boolean;
  }>;
  warnings: Array<{ id: string; severity: string; audience: string; text: string }>;
  productCount: number;
}

async function load(slug: string): Promise<IngredientView> {
  try {
    return await apiRequest<IngredientView>(
      `/api/v1/catalogue/ingredients/${encodeURIComponent(slug)}`,
      { forwardCookies: false, revalidate: 300 },
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const ingredient = await load(slug);

  return {
    title: ingredient.name,
    description:
      ingredient.description ??
      `What ${ingredient.name} is, where we source it from, and the warnings recorded against it.`,
    alternates: { canonical: `/ingredients/${ingredient.slug}` },
  };
}

const AUDIENCE_LABELS: Record<string, string> = {
  GENERAL: 'Everyone',
  PREGNANCY: 'Pregnancy and nursing',
  CHILDREN: 'Children',
  MEDICATION: 'People taking medication',
  ALLERGY: 'Allergies',
  CONDITION: 'Existing health conditions',
};

export default async function IngredientPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const ingredient = await load(slug);

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:px-8">
      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <Link href="/products" className="hover:text-slate-700 hover:underline">
          Products
        </Link>
        <span aria-hidden="true"> / </span>
        <span aria-current="page" className="text-slate-700">
          {ingredient.name}
        </span>
      </nav>

      <header className="mt-4">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{ingredient.name}</h1>
        {ingredient.scientificName ? (
          <p className="mt-1 text-base italic text-slate-600">{ingredient.scientificName}</p>
        ) : null}
        {ingredient.commonNames.length > 0 ? (
          <p className="mt-1 text-sm text-slate-600">
            Also called: {ingredient.commonNames.join(', ')}
          </p>
        ) : null}
        {ingredient.isAllergen ? (
          <p className="mt-3 inline-block rounded bg-amber-100 px-2 py-1 text-sm font-medium text-amber-900">
            Declared allergen{ingredient.allergen ? `: ${ingredient.allergen}` : ''}
          </p>
        ) : null}
      </header>

      {ingredient.description ? (
        <section className="mt-6 max-w-prose">
          <p className="text-base leading-relaxed text-slate-700">{ingredient.description}</p>
        </section>
      ) : null}

      {ingredient.warnings.length > 0 ? (
        <section aria-labelledby="warnings-heading" className="mt-8">
          <h2 id="warnings-heading" className="text-xl font-semibold text-slate-900">
            Warnings
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            These appear on every product containing this ingredient.
          </p>
          <ul className="mt-3 space-y-2">
            {ingredient.warnings.map((warning) => (
              <li
                key={warning.id}
                className={`rounded-lg p-3 text-sm ${
                  warning.severity === 'DANGER'
                    ? 'bg-red-50 text-red-900'
                    : 'bg-slate-100 text-slate-800'
                }`}
              >
                <span className="font-medium">
                  {AUDIENCE_LABELS[warning.audience] ?? warning.audience}:{' '}
                </span>
                {warning.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="sourcing-heading" className="mt-8">
        <h2 id="sourcing-heading" className="text-xl font-semibold text-slate-900">
          Sourcing
        </h2>
        {ingredient.sources.length > 0 ? (
          <ul className="mt-3 space-y-3">
            {ingredient.sources.map((source) => (
              <li key={source.id} className="rounded-lg bg-white p-4 text-sm ring-1 ring-slate-200">
                <p className="font-medium text-slate-900">
                  {source.type.toLowerCase().replace(/_/g, ' ')}
                  {source.originCountry ? ` · ${source.originCountry}` : ''}
                </p>
                {source.description ? (
                  <p className="mt-1 text-slate-600">{source.description}</p>
                ) : null}
                <p className="mt-1 text-slate-600">
                  {source.isVegan
                    ? 'Suitable for vegans.'
                    : source.isVegetarian
                      ? 'Suitable for vegetarians.'
                      : 'Not suitable for vegetarians.'}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          // Saying "not recorded" is the honest answer. Omitting the section
          // entirely would leave a reader to assume something was checked.
          <p className="mt-2 text-sm text-slate-600">
            We have not recorded sourcing details for this ingredient yet.
          </p>
        )}
      </section>

      {ingredient.casNumber ? (
        <p className="mt-6 text-sm text-slate-500">CAS number {ingredient.casNumber}</p>
      ) : null}

      <p className="mt-8 rounded-xl bg-white p-5 text-sm leading-relaxed text-slate-600 ring-1 ring-slate-200">
        This page describes what the ingredient is and how we source it. It is not medical advice
        and says nothing about treating, curing or preventing any condition. Talk to a qualified
        healthcare professional before starting any supplement.
      </p>

      {ingredient.productCount > 0 ? (
        <p className="mt-6">
          <Link
            href={`/products?q=${encodeURIComponent(ingredient.name)}`}
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Find products containing {ingredient.name}
          </Link>
        </p>
      ) : null}
    </div>
  );
}
