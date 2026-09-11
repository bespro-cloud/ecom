import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { browseProducts, categoryTrail, fetchCategoryTree, findCategory } from '@/lib/catalogue';
import type { SearchParams } from '@/lib/facet-links';
import { publicConfig } from '@/lib/env';
import { ProductCard } from '@/components/product-card';
import { ProductSearch } from '@/components/product-search';
import { BreadcrumbStructuredData } from '@/components/structured-data';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const category = findCategory(await fetchCategoryTree(), slug);
  if (!category) return {};

  return {
    title: category.name,
    description:
      category.description ??
      `Everything we list under ${category.name}, with full ingredient records and required warnings.`,
    alternates: { canonical: `/categories/${category.slug}` },
  };
}

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);

  const tree = await fetchCategoryTree();
  const category = findCategory(tree, slug);
  if (!category) notFound();

  const trail = categoryTrail(tree, slug);
  const sort = typeof query.sort === 'string' ? query.sort : undefined;
  const cursor = typeof query.cursor === 'string' ? query.cursor : undefined;

  const { data, meta } = await browseProducts({ category: slug, sort, cursor });

  const breadcrumbs = [
    { name: 'Products', path: '/products' },
    ...trail.map((node) => ({ name: node.name, path: `/categories/${node.slug}` })),
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <BreadcrumbStructuredData trail={breadcrumbs} siteUrl={publicConfig.siteUrl} />

      <nav aria-label="Breadcrumb" className="text-sm text-slate-500">
        <ol className="flex flex-wrap items-center gap-1">
          {breadcrumbs.map((entry, index) => (
            <li key={entry.path} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden="true">/</span> : null}
              {index === breadcrumbs.length - 1 ? (
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

      <header className="mt-4">
        <h1 className="text-3xl font-semibold tracking-tight text-slate-900">{category.name}</h1>
        {category.description ? (
          <p className="mt-2 max-w-prose text-base leading-relaxed text-slate-600">
            {category.description}
          </p>
        ) : null}
        <div className="mt-5 max-w-xl">
          <ProductSearch carry={{ category: slug }} />
        </div>
      </header>

      {category.children.length > 0 ? (
        <nav aria-label="Sub-categories" className="mt-6 flex flex-wrap gap-2">
          {category.children.map((child) => (
            <Link
              key={child.id}
              href={`/categories/${child.slug}`}
              className="rounded-full bg-white px-3 py-1.5 text-sm font-medium text-slate-700 ring-1 ring-slate-200 hover:ring-brand-300"
            >
              {child.name}
              <span className="ml-1.5 text-xs text-slate-500">{child.productCount}</span>
            </Link>
          ))}
        </nav>
      ) : null}

      <p className="mt-6 text-sm text-slate-600" role="status">
        {meta.total === 0
          ? 'Nothing is listed here yet.'
          : `${meta.total} product${meta.total === 1 ? '' : 's'}`}
      </p>

      {data.length > 0 ? (
        <ul className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((product) => (
            <li key={product.id}>
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
