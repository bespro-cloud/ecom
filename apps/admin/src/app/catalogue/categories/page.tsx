import type { Metadata } from 'next';
import { Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { listCategories, type AdminCategory } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { CategoryForm } from '@/components/category-form';

export const metadata: Metadata = { title: 'Categories' };

/**
 * The category tree.
 *
 * Rendered from the materialised `depth` the API returns rather than rebuilt
 * here: the ordering is already root-first, so indentation is a presentation
 * detail rather than a second implementation of the tree.
 */
export default async function CategoriesPage() {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'CATEGORY_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="CATEGORY_READ" />
      </ConsoleShell>
    );
  }

  const categories = await listCategories();
  const canWrite = hasPermission(user, 'CATEGORY_WRITE');

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Categories"
          description="Navigation and the canonical URL of every product. A product needs a primary category before it can be published."
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Tree</h2>
            {categories.length === 0 ? (
              <EmptyState
                title="No categories yet"
                description="Create the first one to start building the navigation."
              />
            ) : (
              <ul className="mt-4 divide-y divide-slate-100">
                {categories.map((category) => (
                  <CategoryRow key={category.id} category={category} />
                ))}
              </ul>
            )}
          </Card>

          {canWrite ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Add a category</h2>
              <div className="mt-4">
                <CategoryForm categories={categories} />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </ConsoleShell>
  );
}

function CategoryRow({ category }: { category: AdminCategory }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0" style={{ paddingLeft: `${category.depth * 1.5}rem` }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{category.name}</span>
        <code className="font-mono text-xs text-slate-500">{category.slug}</code>
        {category.isActive ? null : <Badge tone="warning">inactive</Badge>}
        <span className="text-xs text-slate-500">
          {category.productCount} product{category.productCount === 1 ? '' : 's'}
        </span>
      </div>
      {category.description ? (
        <p className="mt-1 text-sm text-slate-600">{category.description}</p>
      ) : null}
    </li>
  );
}
