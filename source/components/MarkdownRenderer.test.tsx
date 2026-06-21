// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct, rerenderInAct } from '../test-helpers/ink-testing.js';
// Import the built component (tests run against compiled files)
import MarkdownRenderer from './MarkdownRenderer.js';

const stripAnsi = (s: string | undefined) => (s ?? '').replaceAll(/\u001B\[[0-9;]*m/g, '');
const rstrip = (s: string) => s.replaceAll(/[ \t]+$/g, '');

// --- Basic text rendering ---

it.sequential('renders plain text', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Hello world'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Hello world')).toBe(true);
});

// --- Inline formatting ---

it.sequential('renders bold text', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'This is **bold** text'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('bold')).toBe(true);
  expect(frame.includes('This is')).toBe(true);
});

it.sequential('renders italic text', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'This is *italic* text'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('italic')).toBe(true);
  expect(frame.includes('This is')).toBe(true);
});

it.sequential('renders inline code with non-breaking space padding', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Run `npm install` to start'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('\u00A0npm install\u00A0')).toBe(true);
});

it.sequential('renders links', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, 'Visit [example](https://example.com)'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('example')).toBe(true);
});

it.sequential('renders images as text placeholder', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '![alt text](image.png)'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('[Image: alt text]')).toBe(true);
});

// --- Headings ---

it.sequential('renders H1 heading', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '# Main Title'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('# Main Title')).toBe(true);
});

it.sequential('renders H2 heading', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '## Subtitle'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('## Subtitle')).toBe(true);
});

it.sequential('renders H3+ headings with exact depths', async () => {
  const { lastFrame: lf3 } = await renderInAct(React.createElement(MarkdownRenderer, null, '### Section'));
  expect(stripAnsi(lf3()).includes('### Section')).toBe(true);

  const { lastFrame: lf4 } = await renderInAct(React.createElement(MarkdownRenderer, null, '#### Detail'));
  expect(stripAnsi(lf4()).includes('#### Detail')).toBe(true);
});

it.sequential('preserves spacing and trailing blank lines for swallowed heading/table newlines', async () => {
  const { lastFrame: lfHeading } = await renderInAct(
    React.createElement(
      MarkdownRenderer,
      null,
      '## Detailed Review\n\n#### MessageList.tsx change\n\nIn the renderStaticItem function',
    ),
  );
  const frameHeading = stripAnsi(lfHeading());
  expect(
    frameHeading.includes('## Detailed Review\n\n#### MessageList.tsx change\n\nIn the renderStaticItem function'),
  ).toBe(true);

  const { lastFrame: lfTable } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '| col1 |\n| --- |\n| val1 |\n\nParagraph'),
  );
  const frameTable = stripAnsi(lfTable());
  expect(frameTable.includes('val1')).toBe(true);
  expect(frameTable.includes('\n\nParagraph')).toBe(true);
});

// --- Paragraphs ---

it.sequential('renders multiple paragraphs', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, 'First paragraph\n\nSecond paragraph'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('First paragraph')).toBe(true);
  expect(frame.includes('Second paragraph')).toBe(true);
});

// --- Lists ---

it.sequential('renders unordered list', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '- Item 1\n- Item 2\n- Item 3'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Item 1')).toBe(true);
  expect(frame.includes('Item 2')).toBe(true);
  expect(frame.includes('Item 3')).toBe(true);
  // Check for bullet points
  expect(frame.includes('•')).toBe(true);
});

it.sequential('renders ordered list', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '1. First\n2. Second\n3. Third'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('First')).toBe(true);
  expect(frame.includes('Second')).toBe(true);
  expect(frame.includes('Third')).toBe(true);
});

it.sequential('renders nested lists', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '- Parent\n  - Child 1\n  - Child 2'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Parent')).toBe(true);
  expect(frame.includes('Child 1')).toBe(true);
  expect(frame.includes('Child 2')).toBe(true);
});

it.sequential('renders list with inline formatting', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '- **Bold** item\n- *Italic* item'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Bold')).toBe(true);
  expect(frame.includes('Italic')).toBe(true);
});

// --- Code blocks ---

it.sequential('renders fenced code block', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '```\nconst x = 1;\nconsole.log(x);\n```'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('const x = 1;')).toBe(true);
  expect(frame.includes('console.log(x);')).toBe(true);
});

it.sequential('renders code block with language', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '```javascript\nfunction it() {}\n```'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('function it() {}')).toBe(true);
});

it.sequential('renders first code line when it is accidentally joined to the fence language', async () => {
  const markdown = '```typescriptif (enabled) {\n  run();\n}\n```';
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());

  expect(frame.includes('if (enabled) {')).toBe(true);
  expect(frame.includes('run();')).toBe(true);
});

it.sequential('renders indented code block', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '    const x = 1;\n    const y = 2;'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('const x = 1;')).toBe(true);
  expect(frame.includes('const y = 2;')).toBe(true);
});

// --- Blockquotes ---

it.sequential('renders blockquote', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '> This is a quote\n> with multiple lines'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('This is a quote')).toBe(true);
  expect(frame.includes('with multiple lines')).toBe(true);
});

it.sequential('renders nested blockquote', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '> Outer quote\n>> Nested quote'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Outer quote')).toBe(true);
  expect(frame.includes('Nested quote')).toBe(true);
});

// --- Horizontal rules ---

it.sequential('renders horizontal rule', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Before\n\n---\n\nAfter'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Before')).toBe(true);
  expect(frame.includes('After')).toBe(true);
  expect(frame.includes('───')).toBe(true); // Check for rule characters
});

// --- Tables ---

it.sequential('wraps long table cell content within a bounded table width', async () => {
  const markdown = `| File | Change |
| --- | --- |
| \`openai-compatible/model.ts\` | Track \`reasoningContent\` separately from \`reasoning\`; emit both \`reasoning_content\` and \`providerData\` in messages and function_calls; accumulate \`reasoning_content\` delta in streams |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').filter(Boolean);

  expect(frame.includes('reasoningContent')).toBe(true);
  expect(lines.every((line) => line.length <= 100)).toBe(true);
});

it.sequential('renders wide table lines with room for terminal newline wrapping', async () => {
  const markdown = `| Product | Description | Price | Availability |
| --- | --- | --- | --- |
| Laptop Pro X1 | A high-performance ultrabook with a 15.6-inch 4K display, 16GB RAM, 512GB SSD storage, and Intel Core i7 processor for professionals who need speed and reliability. | $1,299.99 | In Stock |
| Wireless Headphones Max | Premium noise-cancelling headphones with 30-hour battery life, Bluetooth 5.0 connectivity, memory foam ear cushions, and a sleek folding design for easy portability. | $349.99 | Only 3 left |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);

  expect(lines.every((line) => line.length < 100)).toBe(true);
});

it.sequential('keeps table header labels intact when reserving column widths', async () => {
  const markdown = `| Product | Description | Price | Availability |
| --- | --- | --- | --- |
| Laptop Pro X1 | A high-performance ultrabook with a 15.6-inch 4K display, 16GB RAM, 512GB SSD storage, and Intel Core i7 processor for professionals who need speed and reliability. | $1,299.99 | In Stock |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);
  const headerLines = lines.slice(
    0,
    lines.findIndex((line, index) => index > 0 && line.trimStart().startsWith('+')),
  );

  expect(headerLines.some((line) => line.includes('Availability'))).toBe(true);
});

it.sequential('renders table borders and header separator with the same width as table rows', async () => {
  const markdown = `| A | B |
| --- | --- |
| 1 | 22 |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);

  // ASCII style is the default.
  const borderLines = lines.filter((line) => line.trimStart().startsWith('+'));
  expect(borderLines.length).toBe(3);

  const [top, middle, bottom] = borderLines;
  expect(top.length).toBe(middle.length);
  expect(top.length).toBe(bottom.length);

  // Pick the first header row line and first data row line and ensure they match border width.
  const headerLine = lines.find((line) => line.trimStart().startsWith('|')) ?? '';
  expect(headerLine.length > 0).toBe(true);
  expect(headerLine.length).toBe(top.length);

  const dataLine = [...lines].reverse().find((line) => line.trimStart().startsWith('|')) ?? '';
  expect(dataLine.length > 0).toBe(true);
  expect(dataLine.length).toBe(top.length);
});

// --- Complex markdown ---

it.sequential('renders complex markdown with multiple elements', async () => {
  const markdown = `# Title

This is a **paragraph** with *formatting*.

## Subtitle

- Item 1
- Item 2

\`\`\`
code block
\`\`\`

---

Final paragraph with \`inline code\``;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Title')).toBe(true);
  expect(frame.includes('paragraph')).toBe(true);
  expect(frame.includes('Subtitle')).toBe(true);
  expect(frame.includes('Item 1')).toBe(true);
  expect(frame.includes('code block')).toBe(true);
  expect(frame.includes('Final paragraph')).toBe(true);
  expect(frame.includes('inline code')).toBe(true);
});

// --- Pre-parsed tokens ---

it.sequential('accepts pre-parsed tokens instead of children', async () => {
  const tokens = [
    {
      type: 'paragraph',
      tokens: [
        {
          type: 'text',
          text: 'Custom tokens',
        },
      ],
    },
  ];

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, { tokens }));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Custom tokens')).toBe(true);
});

it.sequential('rerenders pre-parsed tokens without raw content', async () => {
  const makeTokens = (text: string) => [
    {
      type: 'paragraph',
      tokens: [
        {
          type: 'text',
          text,
        },
      ],
    },
  ];

  const renderer = await renderInAct(React.createElement(MarkdownRenderer, { tokens: makeTokens('First tokens') }));
  await rerenderInAct(renderer, React.createElement(MarkdownRenderer, { tokens: makeTokens('Second tokens') }));

  const frame = stripAnsi(renderer.lastFrame());
  expect(frame.includes('Second tokens')).toBe(true);
  expect(frame.includes('First tokens')).toBe(false);
});

// --- Edge cases ---

it.sequential('handles line breaks', async () => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Line 1  \nLine 2'));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Line 1')).toBe(true);
  expect(frame.includes('Line 2')).toBe(true);
});

it.sequential('escapes special characters', async () => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '\\*not bold\\* and \\`not code\\`'),
  );
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('*not bold*')).toBe(true);
  expect(frame.includes('`not code`')).toBe(true);
});

it.sequential('handles mixed list types', async () => {
  const markdown = `- Unordered 1
- Unordered 2

1. Ordered 1
2. Ordered 2`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  expect(frame.includes('Unordered 1')).toBe(true);
  expect(frame.includes('Ordered 1')).toBe(true);
});
