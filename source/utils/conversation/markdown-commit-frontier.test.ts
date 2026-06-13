import test from 'ava';
import { findMarkdownCommitOffset } from './markdown-commit-frontier.js';

test('keeps the final top-level paragraph mutable', (t) => {
  const source = 'First paragraph.\n\nSecond paragraph.\n\nCurrent tail';

  t.is(findMarkdownCommitOffset(source), 'First paragraph.\n\nSecond paragraph.\n\n'.length);
});

test('uses parser structure for Setext headings', (t) => {
  const source = 'Title\n---\nFollowing paragraph';

  t.is(findMarkdownCommitOffset(source), 'Title\n---\n'.length);
});

test('keeps an unclosed fenced code block mutable', (t) => {
  const source = 'Introduction.\n\n```ts\nconst value = 1;\n';

  t.is(findMarkdownCommitOffset(source), 'Introduction.\n\n'.length);
});

test('commits a closed fenced code block when a following block exists', (t) => {
  const source = '```ts\nconst value = 1;\n```\nFollowing paragraph';

  t.is(findMarkdownCommitOffset(source), '```ts\nconst value = 1;\n```\n'.length);
});

test('keeps reference-definition documents fully mutable', (t) => {
  const source = 'Read [the documentation].\n\nAnother paragraph.\n\n[the documentation]: https://example.com';

  t.is(findMarkdownCommitOffset(source), 0);
});

test('keeps unresolved reference syntax mutable before its definition arrives', (t) => {
  const source = 'Read [the documentation].\n\nAnother paragraph is streaming';

  t.is(findMarkdownCommitOffset(source), 0);
});

test('does not treat inline links as document-wide references', (t) => {
  const source = 'Read [the documentation](https://example.com).\n\nAnother paragraph is streaming';

  t.is(findMarkdownCommitOffset(source), 'Read [the documentation](https://example.com).\n\n'.length);
});

test('does not commit a whitespace-only prefix', (t) => {
  const source = '   \n\nActual content';

  t.is(findMarkdownCommitOffset(source), 0);
});

test('returns an absolute monotonic offset for an uncommitted suffix', (t) => {
  const source = 'Committed.\n\nFirst live block.\n\nSecond live block';
  const committedOffset = 'Committed.\n\n'.length;

  t.is(findMarkdownCommitOffset(source, committedOffset), 'Committed.\n\nFirst live block.\n\n'.length);
});
