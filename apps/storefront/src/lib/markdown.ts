/**
 * A deliberately tiny Markdown subset for CMS rich text.
 *
 * This module never produces HTML. It turns text into a token tree, and the
 * component that renders it maps tokens to React elements — which is what makes
 * pasted markup come out as visible characters rather than executing. There is
 * no `dangerouslySetInnerHTML` anywhere in the path.
 *
 * Four constructs are recognised: paragraphs, bulleted lists, links and
 * emphasis. Anything else is text.
 */

export type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'strong'; value: string }
  | { kind: 'em'; value: string };

export type BlockToken =
  | { kind: 'paragraph'; content: InlineToken[] }
  | { kind: 'list'; items: InlineToken[][] };

const INLINE_PATTERN = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/**
 * Whether a link from stored content may be rendered as a link.
 *
 * Only absolute http(s) and site-relative URLs. A `javascript:` or `data:` href
 * in a CMS field is script execution dressed as a link, and a protocol-relative
 * `//evil.test` reads as site-relative but is not. Anything rejected still
 * shows its text — the words the editor wrote are not lost, only the
 * navigation.
 */
export function isSafeHref(href: string): boolean {
  const trimmed = href.trim();
  if (trimmed.startsWith('//')) return false;
  return /^https?:\/\//i.test(trimmed) || /^\/(?!\/)/.test(trimmed);
}

export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ kind: 'text', value: text.slice(lastIndex, index) });
    }

    const [, linkText, href, strong, em] = match;
    if (linkText !== undefined && href !== undefined) {
      tokens.push(
        isSafeHref(href)
          ? { kind: 'link', text: linkText, href: href.trim() }
          : { kind: 'text', value: linkText },
      );
    } else if (strong !== undefined) {
      tokens.push({ kind: 'strong', value: strong });
    } else if (em !== undefined) {
      tokens.push({ kind: 'em', value: em });
    }

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return tokens;
}

export function parseMarkdown(markdown: string): BlockToken[] {
  return markdown
    .split(/\n{2,}/)
    .filter((part) => part.trim().length > 0)
    .map((part) => {
      const lines = part.split('\n');
      const isList = lines.every((line) => /^\s*[-*]\s+/.test(line));

      return isList
        ? {
            kind: 'list' as const,
            items: lines.map((line) => parseInline(line.replace(/^\s*[-*]\s+/, ''))),
          }
        : { kind: 'paragraph' as const, content: parseInline(part.replace(/\n/g, ' ')) };
    });
}
