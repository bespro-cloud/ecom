import Link from 'next/link';
import { parseMarkdown, type InlineToken } from '@/lib/markdown';

/**
 * Renders CMS content.
 *
 * Content is stored as a fixed vocabulary of typed blocks, never HTML, and this
 * is the half of that decision that pays for it: every block maps to specific
 * elements chosen here, so there is no path by which stored content becomes
 * markup. A block type this component does not know about is skipped rather
 * than guessed at.
 *
 * `richText` is the one block carrying formatting, and it is rendered with a
 * deliberately tiny Markdown subset — paragraphs, lists, links and emphasis.
 * Anything else, including raw HTML, comes out as visible characters.
 */

export interface Block {
  id: string;
  type: string;
  [key: string]: unknown;
}

export function PageBlocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-6">
      {blocks.map((block) => (
        <BlockView key={block.id} block={block} />
      ))}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const level = block.level === 3 ? 3 : block.level === 4 ? 4 : 2;
      const Tag = `h${level}` as const satisfies 'h2' | 'h3' | 'h4';
      const sizes = {
        2: 'text-2xl font-semibold',
        3: 'text-xl font-semibold',
        4: 'text-lg font-semibold',
      } as const;
      return <Tag className={`${sizes[level]} text-slate-900`}>{String(block.text ?? '')}</Tag>;
    }

    case 'richText':
      return <RichText markdown={String(block.markdown ?? '')} />;

    case 'callout': {
      const warning = block.tone === 'warning';
      return (
        <aside
          className={`rounded-lg border-l-4 p-4 ${
            warning ? 'border-amber-500 bg-amber-50' : 'border-brand-500 bg-brand-50'
          }`}
        >
          {block.title ? (
            <p className={`text-sm font-semibold ${warning ? 'text-amber-900' : 'text-brand-900'}`}>
              {String(block.title)}
            </p>
          ) : null}
          <div className={warning ? 'text-amber-900' : 'text-brand-900'}>
            <RichText markdown={String(block.markdown ?? '')} />
          </div>
        </aside>
      );
    }

    case 'image': {
      const url = typeof block.url === 'string' ? block.url : null;
      if (!url) return null;
      return (
        <figure>
          {/* A plain <img>: media is served from a configurable
              object-storage origin. */}
          <img
            src={url}
            alt={String(block.altText ?? '')}
            loading="lazy"
            className="w-full rounded-xl"
          />
          {block.caption ? (
            <figcaption className="mt-2 text-sm text-slate-600">{String(block.caption)}</figcaption>
          ) : null}
        </figure>
      );
    }

    case 'faq': {
      const items = Array.isArray(block.items) ? block.items : [];
      return (
        <div className="divide-y divide-slate-200 rounded-xl bg-white ring-1 ring-slate-200">
          {items.map((item, index) => {
            const entry = item as { question?: string; answer?: string };
            return (
              <details key={index} className="group p-4">
                <summary className="cursor-pointer text-base font-medium text-slate-900">
                  {entry.question ?? ''}
                </summary>
                <div className="mt-2 text-slate-700">
                  <RichText markdown={entry.answer ?? ''} />
                </div>
              </details>
            );
          })}
        </div>
      );
    }

    case 'productGrid': {
      // Products are referenced by id and resolved by the API, so a withdrawn
      // listing disappears from the page instead of 404-ing a customer.
      const products = Array.isArray(block.products) ? block.products : [];
      if (products.length === 0) return null;
      return (
        <section>
          {block.title ? (
            <h2 className="text-xl font-semibold text-slate-900">{String(block.title)}</h2>
          ) : null}
          <ul className="mt-3 grid gap-3 sm:grid-cols-2">
            {products.map((item, index) => {
              const product = item as { slug?: string; name?: string };
              if (!product.slug) return null;
              return (
                <li key={index}>
                  <Link
                    href={`/products/${product.slug}`}
                    className="block rounded-lg bg-white p-4 text-sm font-medium text-slate-900 ring-1 ring-slate-200 hover:ring-brand-300"
                  >
                    {product.name ?? product.slug}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      );
    }

    default:
      // An unknown block type is content this build does not know how to render
      // safely. Skipping it is the only honest option.
      return null;
  }
}

/**
 * Renders the token tree from `@/lib/markdown`.
 *
 * Every token becomes a React element chosen here; nothing from the input is
 * ever interpreted as markup. That is what makes a pasted script tag render as
 * characters, and it is why the parsing is a separate, tested module rather
 * than inline regexes.
 */
function RichText({ markdown }: { markdown: string }) {
  return (
    <>
      {parseMarkdown(markdown).map((block, index) =>
        block.kind === 'list' ? (
          <ul key={index} className="my-2 list-disc space-y-1 pl-5 text-base leading-relaxed">
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}>
                <Inline tokens={item} />
              </li>
            ))}
          </ul>
        ) : (
          <p key={index} className="my-2 text-base leading-relaxed">
            <Inline tokens={block.content} />
          </p>
        ),
      )}
    </>
  );
}

function Inline({ tokens }: { tokens: InlineToken[] }) {
  return (
    <>
      {tokens.map((token, index) => {
        switch (token.kind) {
          case 'link':
            return (
              <Link key={index} href={token.href} className="text-brand-700 underline">
                {token.text}
              </Link>
            );
          case 'strong':
            return <strong key={index}>{token.value}</strong>;
          case 'em':
            return <em key={index}>{token.value}</em>;
          default:
            return <span key={index}>{token.value}</span>;
        }
      })}
    </>
  );
}
