import { describe, expect, it } from 'vitest';
import { isSafeHref, parseInline, parseMarkdown } from './markdown';

describe('isSafeHref', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isSafeHref('https://example.test/page')).toBe(true);
    expect(isSafeHref('http://example.test')).toBe(true);
  });

  it('accepts site-relative URLs', () => {
    expect(isSafeHref('/products/magnesium')).toBe(true);
  });

  it('rejects javascript: however it is written', () => {
    // A CMS field is editable by any account with CONTENT_WRITE. A link that
    // could execute script is a privilege escalation from "edit copy" to
    // "run code in every visitor's browser".
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false);
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects protocol-relative URLs that look site-relative', () => {
    // `//evil.test` reads like a path but navigates off-site.
    expect(isSafeHref('//evil.test/phish')).toBe(false);
  });

  it('rejects other schemes', () => {
    expect(isSafeHref('mailto:someone@example.test')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
  });
});

describe('parseInline', () => {
  it('returns plain text unchanged', () => {
    expect(parseInline('Orders ship in two days.')).toEqual([
      { kind: 'text', value: 'Orders ship in two days.' },
    ]);
  });

  it('recognises links, bold and italic', () => {
    expect(parseInline('See [our policy](/pages/shipping), **now** and *later*.')).toEqual([
      { kind: 'text', value: 'See ' },
      { kind: 'link', text: 'our policy', href: '/pages/shipping' },
      { kind: 'text', value: ', ' },
      { kind: 'strong', value: 'now' },
      { kind: 'text', value: ' and ' },
      { kind: 'em', value: 'later' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('keeps the words of an unsafe link but drops the navigation', () => {
    // The href stops at the first ")", so the stray one here stays as text.
    // What matters is that no link token is produced at all.
    const tokens = parseInline('[Click here](javascript:alert(1))');
    expect(tokens.some((token) => token.kind === 'link')).toBe(false);
    expect(tokens.map((token) => ('value' in token ? token.value : '')).join('')).toBe(
      'Click here)',
    );
  });

  it('drops the navigation from a protocol-relative link', () => {
    const tokens = parseInline('[Our returns policy](//evil.test/phish)');
    expect(tokens).toEqual([{ kind: 'text', value: 'Our returns policy' }]);
  });

  it('treats HTML as characters, never as structure', () => {
    // This is the property the whole block model exists to guarantee: there is
    // no token that can carry markup, so there is nothing for a renderer to
    // turn back into an element.
    const tokens = parseInline('<script>alert(1)</script>');
    expect(tokens).toEqual([{ kind: 'text', value: '<script>alert(1)</script>' }]);
    expect(tokens.every((token) => token.kind === 'text')).toBe(true);
  });

  it('does not treat an unmatched asterisk as emphasis', () => {
    expect(parseInline('2 * 3 = 6')).toEqual([{ kind: 'text', value: '2 * 3 = 6' }]);
  });
});

describe('parseMarkdown', () => {
  it('splits blank-line-separated text into paragraphs', () => {
    const blocks = parseMarkdown('First paragraph.\n\nSecond paragraph.');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true);
  });

  it('joins soft-wrapped lines into one paragraph', () => {
    const [block] = parseMarkdown('a line\nand its continuation');
    expect(block).toEqual({
      kind: 'paragraph',
      content: [{ kind: 'text', value: 'a line and its continuation' }],
    });
  });

  it('recognises a bulleted list', () => {
    const [block] = parseMarkdown('- one\n- two\n- three');
    expect(block?.kind).toBe('list');
    expect(block?.kind === 'list' && block.items).toHaveLength(3);
  });

  it('does not turn a paragraph containing a dash into a list', () => {
    const [block] = parseMarkdown('Two days - sometimes three.');
    expect(block?.kind).toBe('paragraph');
  });

  it('ignores empty blocks', () => {
    expect(parseMarkdown('\n\n   \n\n')).toEqual([]);
  });
});
