// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import SkillSelectionMenu from './SkillSelectionMenu.js';
import type { SkillInfo } from '../../services/skills/skills-service.js';

const MOCK_SKILLS: SkillInfo[] = [
  {
    name: 'skill-one',
    description: 'First test skill description',
    location: '/path/to/one',
    isProjectLevel: false,
    body: 'body',
    rawContent: 'raw',
  },
  {
    name: 'skill-two',
    description: 'Second test skill description',
    location: '/path/to/two',
    isProjectLevel: true,
    body: 'body2',
    rawContent: 'raw2',
  },
];

it('SkillSelectionMenu renders both columns and details of the selected skill', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={MOCK_SKILLS} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  // Left column displays the skill names
  expect(frame?.includes('skill-one')).toBe(true);
  expect(frame?.includes('skill-two')).toBe(true);

  // Right column displays the selected skill's details
  expect(frame?.includes('First test skill description')).toBe(true);
  // Second skill is not selected, so its description is not shown
  expect(frame?.includes('Second test skill description')).toBe(false);

  await act(async () => {
    unmount();
  });
});

it('SkillSelectionMenu displays project level scope if applicable', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={MOCK_SKILLS} selectedIndex={1} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  expect(frame?.includes('Second test skill description')).toBe(true);
  expect(frame?.includes('Scope: Project level')).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('SkillSelectionMenu displays fallback text when there are no skills', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={[]} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  let frame = lastFrame();
  expect(frame?.includes('No skills available')).toBe(true);

  await act(async () => {
    unmount();
  });

  // With query
  await act(async () => {
    const result = render(<SkillSelectionMenu items={[]} selectedIndex={0} query="nonexistent" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  frame = lastFrame();
  expect(frame?.includes('No matching skills')).toBe(true);

  await act(async () => {
    unmount();
  });
});

it('SkillSelectionMenu truncates extremely long skill names in the left column', async () => {
  const extremelyLongSkill: SkillInfo = {
    name: 'extremely-long-skill-name-that-definitely-exceeds-thirty-characters',
    description: 'Extremely long description',
    location: '/path/to/long',
    isProjectLevel: false,
    body: 'body',
    rawContent: 'raw',
  };

  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<SkillSelectionMenu items={[extremelyLongSkill]} selectedIndex={0} query="" />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();

  // The full name should be truncated
  expect(frame?.includes('extremely-long-skill-name-that-definitely-exceeds-thirty-characters')).toBe(false);
  expect(frame?.includes('extremely-long-skill-name')).toBe(true);

  await act(async () => {
    unmount();
  });
});

const WRAPPING_SKILLS: SkillInfo[] = [
  {
    name: 'extremely-long-skill-name-that-definitely-exceeds-thirty-characters',
    description:
      'A long description that keeps going and going with many words to force wrapping behavior in the detail pane',
    location: '/path/to/long',
    isProjectLevel: false,
    body: 'body',
    rawContent: 'raw',
  },
  {
    name: 'other',
    description: 'short',
    location: '/path/to/other',
    isProjectLevel: true,
    body: 'body2',
    rawContent: 'raw2',
  },
];

// Regression: a long description used to shrink the left pane from its
// intended width, steal the marker's cells, and leave a jagged divider.
for (const width of [80, 40, 24]) {
  it.sequential(`keeps the list gutter, divider, and full detail at ${width} cols`, async () => {
    const { lastFrame } = await renderInAct(
      <Box width={width}>
        <SkillSelectionMenu items={WRAPPING_SKILLS} selectedIndex={0} query="" />
      </Box>,
    );

    const frame = toVisibleText(lastFrame()!);
    const lines = frame.split('\n');

    // Stable two-cell marker gutter: `❯ ` on the selected row, two spaces
    // on the others.
    expect(lines.some((line) => /❯ /.test(line))).toBe(true);
    expect(lines.some((line) => line.includes('other'))).toBe(true);
    const otherLine = lines.find((line) => line.includes('other') && !line.includes('Scope'));
    expect(otherLine).not.toContain('❯');

    // The divider stays in one column across the list rows: every menu
    // line carrying an interior divider puts it at the same index. (The
    // key-hint footer reuses │ as a separator, so it is excluded.)
    const dividerColumns = lines
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/navigate|select|resume|cancel|switch/.test(line))
      .map((line) => {
        const indices: number[] = [];
        for (let i = 1; i < line.length - 1; i++) {
          if (line[i] === '│') indices.push(i);
        }
        return indices;
      })
      .filter((indices) => indices.length > 0)
      .map((indices) => indices[0]);
    expect(dividerColumns.length).toBeGreaterThan(0);
    expect(new Set(dividerColumns).size).toBe(1);

    // Nothing lost: the full skill name and the whole description survive
    // in the detail column (the list shows a stub). The detail text is
    // read down its own column: row-major order would interleave list rows
    // between the detail's wrapped lines on wide terminals.
    const divider = dividerColumns[0];
    const detailCompact = lines
      .map((line) => (line[divider] === '│' ? line.slice(divider + 1) : line))
      .join('\n')
      .replace(/[│╭╮╰╯─]/g, '')
      .replace(/\s+/g, '');
    const words = (s: string) => s.replace(/\s+/g, '');
    expect(detailCompact).toContain('extremely-long-skill-name-that-definitely-exceeds-thirty-characters');
    expect(detailCompact).toContain(
      words(
        'A long description that keeps going and going with many words to force wrapping behavior in the detail pane',
      ),
    );
    expect(detailCompact).toContain(words('Scope: Global'));

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
}
