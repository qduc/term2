import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
// Import the built component (tests run against compiled files)
import MarkdownRenderer from '../../dist/components/MarkdownRenderer.js';

const stripAnsi = (s) => s.replaceAll(/\u001B\[[0-9;]*m/g, '');
const rstrip = (s) => s.replaceAll(/[ \t]+$/g, '');

// --- Basic text rendering ---

test('renders plain text', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'Hello world'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Hello world'));
});

test('renders empty string', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, ''));
  const frame = lastFrame();
  t.is(typeof frame, 'string');
});

// --- Inline formatting ---

test('renders bold text', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'This is **bold** text'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('bold'));
  t.true(frame.includes('This is'));
});

test('renders italic text', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'This is *italic* text'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('italic'));
  t.true(frame.includes('This is'));
});

test('renders inline code with non-breaking space padding', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'Run `npm install` to start'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('\u00A0npm install\u00A0'));
});

test('renders links', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'Visit [example](https://example.com)'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('example'));
});

test('renders images as text placeholder', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '![alt text](image.png)'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('[Image: alt text]'));
});

test('renders combined inline formatting', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '**bold** and *italic* and `code`'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('bold'));
  t.true(frame.includes('italic'));
  t.true(frame.includes('code'));
});

// --- Headings ---

test('renders H1 heading', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '# Main Title'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('# Main Title'));
});

test('renders H2 heading', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '## Subtitle'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('## Subtitle'));
});

test('renders H3+ headings with exact depths', (t) => {
  const { lastFrame: lf3 } = render(React.createElement(MarkdownRenderer, null, '### Section'));
  t.true(stripAnsi(lf3()).includes('### Section'));

  const { lastFrame: lf4 } = render(React.createElement(MarkdownRenderer, null, '#### Detail'));
  t.true(stripAnsi(lf4()).includes('#### Detail'));
});

test('preserves spacing and trailing blank lines for swallowed heading/table newlines', (t) => {
  const { lastFrame: lfHeading } = render(
    React.createElement(
      MarkdownRenderer,
      null,
      '## Detailed Review\n\n#### MessageList.tsx change\n\nIn the renderStaticItem function',
    ),
  );
  const frameHeading = stripAnsi(lfHeading());
  t.true(
    frameHeading.includes('## Detailed Review\n\n#### MessageList.tsx change\n\nIn the renderStaticItem function'),
  );

  const { lastFrame: lfTable } = render(
    React.createElement(MarkdownRenderer, null, '| col1 |\n| --- |\n| val1 |\n\nParagraph'),
  );
  const frameTable = stripAnsi(lfTable());
  t.true(frameTable.includes('val1'));
  t.true(frameTable.includes('\n\nParagraph'));
});

// --- Paragraphs ---

test('renders multiple paragraphs', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'First paragraph\n\nSecond paragraph'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('First paragraph'));
  t.true(frame.includes('Second paragraph'));
});

// --- Lists ---

test('renders unordered list', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '- Item 1\n- Item 2\n- Item 3'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Item 1'));
  t.true(frame.includes('Item 2'));
  t.true(frame.includes('Item 3'));
  // Check for bullet points
  t.true(frame.includes('•'));
});

test('renders ordered list', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '1. First\n2. Second\n3. Third'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('First'));
  t.true(frame.includes('Second'));
  t.true(frame.includes('Third'));
});

test('renders nested lists', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '- Parent\n  - Child 1\n  - Child 2'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Parent'));
  t.true(frame.includes('Child 1'));
  t.true(frame.includes('Child 2'));
});

test('renders list with inline formatting', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '- **Bold** item\n- *Italic* item'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Bold'));
  t.true(frame.includes('Italic'));
});

// --- Code blocks ---

test('renders fenced code block', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '```\nconst x = 1;\nconsole.log(x);\n```'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('const x = 1;'));
  t.true(frame.includes('console.log(x);'));
});

test('renders code block with language', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '```javascript\nfunction test() {}\n```'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('function test() {}'));
});

test('renders first code line when it is accidentally joined to the fence language', (t) => {
  const markdown = '```typescriptif (enabled) {\n  run();\n}\n```';
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());

  t.true(frame.includes('if (enabled) {'));
  t.true(frame.includes('run();'));
});

test('renders indented code block', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '    const x = 1;\n    const y = 2;'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('const x = 1;'));
  t.true(frame.includes('const y = 2;'));
});

// --- Blockquotes ---

test('renders blockquote', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '> This is a quote\n> with multiple lines'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('This is a quote'));
  t.true(frame.includes('with multiple lines'));
});

test('renders nested blockquote', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '> Outer quote\n>> Nested quote'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Outer quote'));
  t.true(frame.includes('Nested quote'));
});

// --- Horizontal rules ---

test('renders horizontal rule', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'Before\n\n---\n\nAfter'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Before'));
  t.true(frame.includes('After'));
  t.true(frame.includes('───')); // Check for rule characters
});

// --- Tables ---

test('wraps long table cell content within a bounded table width', (t) => {
  const markdown = `| File | Change |
| --- | --- |
| \`openai-compatible/model.ts\` | Track \`reasoningContent\` separately from \`reasoning\`; emit both \`reasoning_content\` and \`providerData\` in messages and function_calls; accumulate \`reasoning_content\` delta in streams |`;

  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').filter(Boolean);

  t.true(frame.includes('reasoningContent'));
  t.true(lines.every((line) => line.length <= 100));
});

test('renders wide table lines with room for terminal newline wrapping', (t) => {
  const markdown = `| Product | Description | Price | Availability |
| --- | --- | --- | --- |
| Laptop Pro X1 | A high-performance ultrabook with a 15.6-inch 4K display, 16GB RAM, 512GB SSD storage, and Intel Core i7 processor for professionals who need speed and reliability. | $1,299.99 | In Stock |
| Wireless Headphones Max | Premium noise-cancelling headphones with 30-hour battery life, Bluetooth 5.0 connectivity, memory foam ear cushions, and a sleek folding design for easy portability. | $349.99 | Only 3 left |`;

  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);

  t.true(lines.every((line) => line.length < 100));
});

test('keeps table header labels intact when reserving column widths', (t) => {
  const markdown = `| Product | Description | Price | Availability |
| --- | --- | --- | --- |
| Laptop Pro X1 | A high-performance ultrabook with a 15.6-inch 4K display, 16GB RAM, 512GB SSD storage, and Intel Core i7 processor for professionals who need speed and reliability. | $1,299.99 | In Stock |`;

  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  const lines = frame.split('\n').map(rstrip).filter(Boolean);
  const headerLines = lines.slice(
    0,
    lines.findIndex((line, index) => index > 0 && line.trimStart().startsWith('+')),
  );

  t.true(headerLines.some((line) => line.includes('Availability')));
});

test('renders table borders and header separator with the same width as table rows', (t) => {
  const markdown = `| A | B |
| --- | --- |
| 1 | 22 |`;

  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
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

  const dataLine = lines.findLast((line) => line.trimStart().startsWith('|')) ?? '';
  t.true(dataLine.length > 0);
  t.is(dataLine.length, top.length);
});

// --- Complex markdown ---

test('renders complex markdown with multiple elements', (t) => {
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

  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
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

test('accepts pre-parsed tokens instead of children', (t) => {
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

  const { lastFrame } = render(React.createElement(MarkdownRenderer, { tokens }));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Custom tokens'));
});

test('rerenders pre-parsed tokens without raw content', (t) => {
  const makeTokens = (text) => [
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

  const renderer = render(React.createElement(MarkdownRenderer, { tokens: makeTokens('First tokens') }));
  renderer.rerender(React.createElement(MarkdownRenderer, { tokens: makeTokens('Second tokens') }));

  const frame = stripAnsi(renderer.lastFrame());
  t.true(frame.includes('Second tokens'));
  t.false(frame.includes('First tokens'));
});

// --- Edge cases ---

test('handles line breaks', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, 'Line 1  \nLine 2'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Line 1'));
  t.true(frame.includes('Line 2'));
});

test('escapes special characters', (t) => {
  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, '\\*not bold\\* and \\`not code\\`'));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('*not bold*'));
  t.true(frame.includes('`not code`'));
});

test('handles mixed list types', (t) => {
  const markdown = `- Unordered 1
- Unordered 2

1. Ordered 1
2. Ordered 2`;

  const { lastFrame } = render(React.createElement(MarkdownRenderer, null, markdown));
  const frame = stripAnsi(lastFrame());
  t.true(frame.includes('Unordered 1'));
  t.true(frame.includes('Ordered 1'));
});
