// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct, rerenderInAct } from '../test-helpers/ink-testing.js';
// Import the built component (tests run against compiled files)
import MarkdownRenderer from './MarkdownRenderer.js';

const stripAnsi = (s: string | undefined) => (s ?? '').replaceAll(/\u001B\[[0-9;]*m/g, '');
const rstrip = (s: string) => s.replaceAll(/[ \t]+$/g, '');

// --- Basic text rendering ---

test.serial('renders plain text', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Hello world'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Hello world'));
});

// --- Inline formatting ---

test.serial('renders bold text', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'This is **bold** text'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('bold'));
  t.true(frame.includes('This is'));
});

test.serial('renders italic text', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'This is *italic* text'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('italic'));
  t.true(frame.includes('This is'));
});

test.serial('renders inline code with non-breaking space padding', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Run `npm install` to start'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('\u00A0npm install\u00A0'));
});

test.serial('renders links', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, 'Visit [example](https://example.com)'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('example'));
});

test.serial('renders images as text placeholder', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '![alt text](image.png)'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('[Image: alt text]'));
});

// --- Headings ---

test.serial('renders H1 heading', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '# Main Title'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('# Main Title'));
});

test.serial('renders H2 heading', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, '## Subtitle'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('## Subtitle'));
});

test.serial('renders H3+ headings with exact depths', async (t) => {
  const { lastFrame: lf3 } = await renderInAct(React.createElement(MarkdownRenderer, null, '### Section'), t);
  t.true(stripAnsi(lf3()).includes('### Section'));

  const { lastFrame: lf4 } = await renderInAct(React.createElement(MarkdownRenderer, null, '#### Detail'), t);
  t.true(stripAnsi(lf4()).includes('#### Detail'));
});

test.serial('preserves spacing and trailing blank lines for swallowed heading/table newlines', async (t) => {
  const { lastFrame: lfHeading } = await renderInAct(
    React.createElement(
      MarkdownRenderer,
      null,
      '## Detailed Review\n\n#### MessageList.tsx change\n\nIn the renderStaticItem function',
    ),
    t,
  );
  const frameHeading = stripAnsi(lfHeading());
  t.true(
    frameHeading.includes('## Detailed Review\n\n#### MessageList.tsx change\n\nIn the renderStaticItem function'),
  );

  const { lastFrame: lfTable } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '| col1 |\n| --- |\n| val1 |\n\nParagraph'),
    t,
  );
  const frameTable = stripAnsi(lfTable());
  t.true(frameTable.includes('val1'));
  t.true(frameTable.includes('\n\nParagraph'));
});

// --- Paragraphs ---

test.serial('renders multiple paragraphs', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, 'First paragraph\n\nSecond paragraph'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('First paragraph'));
  t.true(frame.includes('Second paragraph'));
});

// --- Lists ---

test.serial('renders unordered list', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '- Item 1\n- Item 2\n- Item 3'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Item 1'));
  t.true(frame.includes('Item 2'));
  t.true(frame.includes('Item 3'));
  // Check for bullet points
  t.true(frame.includes('•'));
});

test.serial('renders ordered list', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '1. First\n2. Second\n3. Third'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('First'));
  t.true(frame.includes('Second'));
  t.true(frame.includes('Third'));
});

test.serial('renders nested lists', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '- Parent\n  - Child 1\n  - Child 2'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Parent'));
  t.true(frame.includes('Child 1'));
  t.true(frame.includes('Child 2'));
});

test.serial('renders list with inline formatting', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '- **Bold** item\n- *Italic* item'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Bold'));
  t.true(frame.includes('Italic'));
});

// --- Code blocks ---

test.serial('renders fenced code block', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '```\nconst x = 1;\nconsole.log(x);\n```'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('const x = 1;'));
  t.true(frame.includes('console.log(x);'));
});

test.serial('renders code block with language', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '```javascript\nfunction test() {}\n```'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('function test() {}'));
});

test.serial('renders first code line when it is accidentally joined to the fence language', async (t) => {
  const markdown = '```typescriptif (enabled) {\n  run();\n}\n```';
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());

  t.true(frame.includes('if (enabled) {'));
  t.true(frame.includes('run();'));
});

test.serial('renders indented code block', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '    const x = 1;\n    const y = 2;'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('const x = 1;'));
  t.true(frame.includes('const y = 2;'));
});

// --- Blockquotes ---

test.serial('renders blockquote', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '> This is a quote\n> with multiple lines'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('This is a quote'));
  t.true(frame.includes('with multiple lines'));
});

test.serial('renders nested blockquote', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '> Outer quote\n>> Nested quote'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Outer quote'));
  t.true(frame.includes('Nested quote'));
});

// --- Horizontal rules ---

test.serial('renders horizontal rule', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Before\n\n---\n\nAfter'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Before'));
  t.true(frame.includes('After'));
  t.true(frame.includes('───')); // Check for rule characters
});

// --- Tables ---

test.serial('wraps long table cell content within a bounded table width', async (t) => {
  const markdown = `| File | Change |
| --- | --- |
| \`openai-compatible/model.ts\` | Track \`reasoningContent\` separately from \`reasoning\`; emit both \`reasoning_content\` and \`providerData\` in messages and function_calls; accumulate \`reasoning_content\` delta in streams |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').filter(Boolean);

  t.true(frame.includes('reasoningContent'));
  t.true(lines.every((line) => line.length <= 100));
});

test.serial('renders wide table lines with room for terminal newline wrapping', async (t) => {
  const markdown = `| Product | Description | Price | Availability |
| --- | --- | --- | --- |
| Laptop Pro X1 | A high-performance ultrabook with a 15.6-inch 4K display, 16GB RAM, 512GB SSD storage, and Intel Core i7 processor for professionals who need speed and reliability. | $1,299.99 | In Stock |
| Wireless Headphones Max | Premium noise-cancelling headphones with 30-hour battery life, Bluetooth 5.0 connectivity, memory foam ear cushions, and a sleek folding design for easy portability. | $349.99 | Only 3 left |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);

  t.true(lines.every((line) => line.length < 100));
});

test.serial('keeps table header labels intact when reserving column widths', async (t) => {
  const markdown = `| Product | Description | Price | Availability |
| --- | --- | --- | --- |
| Laptop Pro X1 | A high-performance ultrabook with a 15.6-inch 4K display, 16GB RAM, 512GB SSD storage, and Intel Core i7 processor for professionals who need speed and reliability. | $1,299.99 | In Stock |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);
  const headerLines = lines.slice(
    0,
    lines.findIndex((line, index) => index > 0 && line.trimStart().startsWith('+')),
  );

  t.true(headerLines.some((line) => line.includes('Availability')));
});

test.serial('renders table borders and header separator with the same width as table rows', async (t) => {
  const markdown = `| A | B |
| --- | --- |
| 1 | 22 |`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);

  // ASCII style is the default.
  const borderLines = lines.filter((line) => line.trimStart().startsWith('+'));
  t.is(borderLines.length, 3);

  const [top, middle, bottom] = borderLines;
  t.is(top.length, middle.length);
  t.is(top.length, bottom.length);

  // Pick the first header row line and first data row line and ensure they match border width.
  const headerLine = lines.find((line) => line.trimStart().startsWith('|')) ?? '';
  t.true(headerLine.length > 0);
  t.is(headerLine.length, top.length);

  const dataLine = [...lines].reverse().find((line) => line.trimStart().startsWith('|')) ?? '';
  t.true(dataLine.length > 0);
  t.is(dataLine.length, top.length);
});

// --- Complex markdown ---

test.serial('renders complex markdown with multiple elements', async (t) => {
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

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Title'));
  t.true(frame.includes('paragraph'));
  t.true(frame.includes('Subtitle'));
  t.true(frame.includes('Item 1'));
  t.true(frame.includes('code block'));
  t.true(frame.includes('Final paragraph'));
  t.true(frame.includes('inline code'));
});

// --- Pre-parsed tokens ---

test.serial('accepts pre-parsed tokens instead of children', async (t) => {
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

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, { tokens }), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Custom tokens'));
});

test.serial('rerenders pre-parsed tokens without raw content', async (t) => {
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

  const renderer = await renderInAct(React.createElement(MarkdownRenderer, { tokens: makeTokens('First tokens') }), t);
  await rerenderInAct(renderer, React.createElement(MarkdownRenderer, { tokens: makeTokens('Second tokens') }));

  const frame = stripAnsi(renderer.lastFrame());
  t.true(frame.includes('Second tokens'));
  t.false(frame.includes('First tokens'));
});

// --- Edge cases ---

test.serial('handles line breaks', async (t) => {
  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, 'Line 1  \nLine 2'), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Line 1'));
  t.true(frame.includes('Line 2'));
});

test.serial('escapes special characters', async (t) => {
  const { lastFrame } = await renderInAct(
    React.createElement(MarkdownRenderer, null, '\\*not bold\\* and \\`not code\\`'),
    t,
  );
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('*not bold*'));
  t.true(frame.includes('`not code`'));
});

test.serial('handles mixed list types', async (t) => {
  const markdown = `- Unordered 1
- Unordered 2

1. Ordered 1
2. Ordered 2`;

  const { lastFrame } = await renderInAct(React.createElement(MarkdownRenderer, null, markdown), t);
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Unordered 1'));
  t.true(frame.includes('Ordered 1'));
});
