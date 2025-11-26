import React from 'react';
import {render} from 'ink';
import MarkdownRenderer from './dist/components/MarkdownRenderer.js';

const sampleMarkdown = `
# Heading 1
## Heading 2

This is a paragraph with **bold** and *italic* text.
Here is some \`inline code\`.

- List item 1
- List item 2
  - Nested item

1. Ordered item 1
2. Ordered item 2

> This is a blockquote.

\`\`\`js
console.log('Code block');
\`\`\`

---

[Link](https://example.com)
`;

const App = () => {
	return React.createElement(MarkdownRenderer, {children: sampleMarkdown});
};

render(React.createElement(App));
