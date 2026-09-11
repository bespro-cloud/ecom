import type { Metadata } from 'next';
import { Alert, Badge, Card, EmptyState, PageHeader } from '@health/ui';
import { listIngredients, type AdminIngredient } from '@/lib/catalogue';
import { currentUser } from '@/lib/session';
import { ConsoleShell } from '@/components/console-shell';
import { PermissionNotice, hasPermission } from '@/components/require-permission';
import { IngredientForm } from '@/components/ingredient-form';

export const metadata: Metadata = { title: 'Ingredients' };

/**
 * The ingredient library.
 *
 * Ingredients are shared entities, not free text on a product, and this screen
 * is where that pays off: a warning added here appears on every listing that
 * uses the ingredient, without anyone editing those listings — and re-opens
 * their compliance approvals, because the previous approval did not cover it.
 */
export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await currentUser();
  if (!user) return null;

  if (!hasPermission(user, 'INGREDIENT_READ')) {
    return (
      <ConsoleShell user={user}>
        <PermissionNotice user={user} permission="INGREDIENT_READ" />
      </ConsoleShell>
    );
  }

  const params = await searchParams;
  const search = typeof params.search === 'string' ? params.search : undefined;
  const ingredients = await listIngredients(search);

  return (
    <ConsoleShell user={user}>
      <div className="space-y-6">
        <PageHeader
          title="Ingredients"
          description="Shared records. When a supplier changes, an interaction is identified or a lot is recalled, the question “which products contain this?” has to be answerable."
        />

        <Alert tone="warning">
          Adding or removing a warning, or changing an allergen flag, re-opens the compliance
          approval of every product containing the ingredient and takes live listings down. That is
          blunt on purpose: deciding which safety changes are minor enough to skip is not a
          judgement this system is entitled to make.
        </Alert>

        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <Card>
            <form method="get" className="flex gap-2">
              <label htmlFor="ingredient-search" className="sr-only">
                Search ingredients
              </label>
              <input
                id="ingredient-search"
                type="search"
                name="search"
                defaultValue={search ?? ''}
                placeholder="Name or synonym"
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-200"
              />
              <button
                type="submit"
                className="shrink-0 rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Search
              </button>
            </form>

            {ingredients.length === 0 ? (
              <div className="mt-4">
                <EmptyState
                  title="No ingredients match"
                  description="Try a different term, or add the ingredient."
                />
              </div>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100">
                {ingredients.map((ingredient) => (
                  <IngredientRow key={ingredient.id} ingredient={ingredient} />
                ))}
              </ul>
            )}
          </Card>

          {hasPermission(user, 'INGREDIENT_WRITE') ? (
            <Card>
              <h2 className="text-lg font-semibold text-slate-900">Add an ingredient</h2>
              <div className="mt-4">
                <IngredientForm />
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </ConsoleShell>
  );
}

function IngredientRow({ ingredient }: { ingredient: AdminIngredient }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-900">{ingredient.name}</span>
        {ingredient.scientificName ? (
          <span className="text-sm italic text-slate-500">{ingredient.scientificName}</span>
        ) : null}
        {ingredient.isAllergen ? (
          <Badge tone="warning">
            allergen{ingredient.allergen ? `: ${ingredient.allergen}` : ''}
          </Badge>
        ) : null}
        {ingredient.warnings.length > 0 ? (
          <Badge tone="info">
            {ingredient.warnings.length} warning{ingredient.warnings.length === 1 ? '' : 's'}
          </Badge>
        ) : null}
        <span className="text-xs text-slate-500">
          used by {ingredient.productCount} product{ingredient.productCount === 1 ? '' : 's'}
        </span>
      </div>
      {ingredient.description ? (
        <p className="mt-1 text-sm text-slate-600">{ingredient.description}</p>
      ) : null}
      {ingredient.warnings.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-slate-700">
          {ingredient.warnings.map((warning) => (
            <li key={warning.id}>
              <span className="font-medium">
                {warning.audience.toLowerCase().replace(/_/g, ' ')}:
              </span>{' '}
              {warning.text}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
