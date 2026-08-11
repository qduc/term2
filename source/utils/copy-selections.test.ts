import { describe, expect, it } from 'vitest';
import { buildCopySelections, extractFencedCodeBlocks } from './copy-selections.js';

describe('extractFencedCodeBlocks', () => {
  it('extracts fenced blocks without their language or fence markers', () => {
    const response = 'Before\n```ts\nconst first = 1;\n```\nBetween\n```\nsecond\n```\nAfter';

    expect(extractFencedCodeBlocks(response)).toEqual(['const first = 1;', 'second']);
  });

  it('preserves blank lines inside fenced blocks and ignores inline backticks', () => {
    const response = 'Use `inline` here.\n```\nline one\n\nline three\n```';

    expect(extractFencedCodeBlocks(response)).toEqual(['line one\n\nline three']);
  });

  it('ignores an unclosed fence', () => {
    expect(extractFencedCodeBlocks('```ts\nconst unfinished = true;')).toEqual([]);
  });
});

it('buildCopySelections puts the full response before its code blocks', () => {
  const response = 'Answer\n```js\nconsole.log(1);\n```';

  expect(buildCopySelections(response)).toEqual([
    { label: 'Full response', text: response },
    { label: 'Code block #1', text: 'console.log(1);' },
  ]);
});
