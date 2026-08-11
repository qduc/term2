// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import CopyMenu, { getCodePreview } from './CopyMenu.js';
import type { CopySelection } from '../../utils/copy-selections.js';

describe('getCodePreview', () => {
  it('returns empty string for empty text', () => {
    expect(getCodePreview('')).toBe('');
    expect(getCodePreview('   \n  ')).toBe('');
  });

  it('normalizes newlines and spaces to a single line', () => {
    expect(getCodePreview('function foo() {\n  return 42;\n}')).toBe('function foo() { return 42; }');
  });

  it('truncates long text to maxLength with an ellipsis', () => {
    const longCode = 'const variableName = "a".repeat(100); console.log(variableName);';
    const preview = getCodePreview(longCode, 40);
    expect(preview.length).toBe(40);
    expect(preview).toBe('const variableName = "a".repeat(100); c…');
  });
});

describe('CopyMenu', () => {
  const items: CopySelection[] = [
    { label: 'Full response', text: 'Here is the code:\n```js\nconsole.log("hello");\n```' },
    { label: 'Code block #1', text: 'console.log("hello");' },
    { label: 'Code block #2', text: 'function add(a: number, b: number) {\n  return a + b;\n}' },
  ];

  it('renders item labels and code block previews', async () => {
    const { lastFrame } = await renderInAct(<CopyMenu items={items} selectedIndex={0} />);
    const output = lastFrame() ?? '';

    expect(output).toContain('1. Full response');
    expect(output).toContain('2. Code block #1');
    expect(output).toContain('— console.log("hello");');
    expect(output).toContain('3. Code block #2');
    expect(output).toContain('— function add(a: number, b: number) { return a + b; }');
  });

  it('does not render code block preview for full response item', async () => {
    const { lastFrame } = await renderInAct(<CopyMenu items={items} selectedIndex={0} />);
    const output = lastFrame() ?? '';

    // Full response item should not have a code block preview appended
    expect(output).not.toContain('1. Full response —');
  });
});
