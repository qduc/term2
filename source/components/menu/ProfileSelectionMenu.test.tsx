// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { Box } from 'ink';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import ProfileSelectionMenu from './ProfileSelectionMenu.js';
import type { ProfileOption } from '../../hooks/use-profile-selection.js';

const WRAPPING_PROFILES: ProfileOption[] = [
  {
    id: 'builtin:standard',
    shortId: 'standard',
    displayName: 'Standard Mode With A Long Display Name',
    detail: 'Default profile with full tool access and balanced behavior across many situations',
  },
  {
    id: 'builtin:plan',
    shortId: 'plan',
    displayName: 'Plan',
    detail: 'Read-only research and planning',
  },
];

// Same split-pane contract as the skills/resume menus: stable gutter,
// straight divider, full detail, nothing past the terminal edge.
for (const width of [80, 40, 24]) {
  it.sequential(`keeps the list gutter, divider, and full detail at ${width} cols`, async () => {
    const { lastFrame } = await renderInAct(
      <Box width={width}>
        <ProfileSelectionMenu items={WRAPPING_PROFILES} activeProfileId="builtin:standard" selectedIndex={0} query="" />
      </Box>,
    );

    const frame = toVisibleText(lastFrame()!);
    const lines = frame.split('\n');

    // Selected row keeps its gutter; the active profile keeps its ● marker.
    const selectedLine = lines.find((line) => line.includes('❯'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toMatch(/❯ .*Standard/);
    expect(frame).toContain('● Standard');
    const planLine = lines.find((line) => line.includes('Plan') && !line.includes('Standard'));
    expect(planLine).toBeDefined();
    expect(planLine).not.toContain('❯');

    // The divider stays in one column across the list rows. (The key-hint
    // footer reuses │ as a separator, so it is excluded.)
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

    // Nothing lost: the selected profile's full display name and detail
    // survive in the detail column (the list shows a stub). The detail text
    // is read down its own column: row-major order would interleave list
    // rows between the detail's wrapped lines on wide terminals.
    const divider = dividerColumns[0];
    const detailCompact = lines
      .map((line) => (line[divider] === '│' ? line.slice(divider + 1) : line))
      .join('\n')
      .replace(/[│╭╮╰╯─]/g, '')
      .replace(/\s+/g, '');
    const words = (s: string) => s.replace(/\s+/g, '');
    expect(detailCompact).toContain(words('Standard Mode With A Long Display Name'));
    expect(detailCompact).toContain(
      words('Default profile with full tool access and balanced behavior across many situations'),
    );
    expect(detailCompact).toContain(words('Currently active'));

    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });
}

it.sequential('names the active profile instead of the switch hint', async () => {
  const { lastFrame } = await renderInAct(
    <Box width={80}>
      <ProfileSelectionMenu items={WRAPPING_PROFILES} activeProfileId="builtin:plan" selectedIndex={1} query="" />
    </Box>,
  );

  const frame = toVisibleText(lastFrame()!);
  expect(frame).toContain('Currently active');
  expect(frame).not.toContain('Run /profile plan to switch');
});
