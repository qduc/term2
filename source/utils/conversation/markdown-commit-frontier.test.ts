import { it, expect } from 'vitest';
import { findMarkdownCommitOffset } from './markdown-commit-frontier.js';

it('keeps the final top-level paragraph mutable', () => {
  const source = 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail';

  expect(findMarkdownCommitOffset(source)).toBe('First paragraph.\n\nSecond paragraph.\n\n'.length);
});

it('uses parser structure for Setext headings', () => {
  const source = 'Title\n---\nFollowing paragraph';

  expect(findMarkdownCommitOffset(source)).toBe('Title\n---\n'.length);
});

it('keeps an unclosed fenced code block mutable', () => {
  const source = 'Introduction.\n\n```ts\nconst value = 1;\n';

  expect(findMarkdownCommitOffset(source)).toBe('Introduction.\n\n'.length);
});

it('commits a closed fenced code block when a following block exists', () => {
  const source = '```ts\nconst value = 1;\n```\nFollowing paragraph';

  expect(findMarkdownCommitOffset(source)).toBe('```ts\nconst value = 1;\n```\n'.length);
});

it('keeps reference-definition documents fully mutable', () => {
  const source = 'Read [the documentation].\n\nAnother paragraph.\n\n[the documentation]: https://example.com';

  expect(findMarkdownCommitOffset(source)).toBe(0);
});

it('keeps unresolved reference syntax mutable before its definition arrives', () => {
  const source = 'Read [the documentation].\n\nAnother paragraph is streaming';

  expect(findMarkdownCommitOffset(source)).toBe(0);
});

it('does not treat inline links as document-wide references', () => {
  const source = 'Read [the documentation](https://example.com).\n\nAnother paragraph is streaming';

  expect(findMarkdownCommitOffset(source)).toBe('Read [the documentation](https://example.com).\n\n'.length);
});

it('does not commit a whitespace-only prefix', () => {
  const source = '   \n\nActual content';

  expect(findMarkdownCommitOffset(source)).toBe(0);
});

it('returns an absolute monotonic offset for an uncommitted suffix', () => {
  const source = 'Committed.\n\nFirst live block.\n\nSecond live block';
  const committedOffset = 'Committed.\n\n'.length;

  expect(findMarkdownCommitOffset(source, committedOffset)).toBe('Committed.\n\nFirst live block.\n\n'.length);
});
