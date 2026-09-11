// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
global.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';
import { Box, Text } from 'ink';
import { MenuContainer, MenuScrollbar, SelectionMarker } from './MenuContainer.js';

it.sequential('MenuContainer renders items', async () => {
  const { lastFrame } = await renderInAct(
    <MenuContainer
      items={['a', 'b', 'c']}
      selectedIndex={0}
      borderColor="magenta"
      renderItem={(item) => <Text key={item}>{item}</Text>}
    />,
  );

  const output = lastFrame();
  expect(output).toBeTruthy();
  expect(output!.includes('a')).toBe(true);
  expect(output!.includes('b')).toBe(true);
  expect(output!.includes('c')).toBe(true);
});

it.sequential('MenuContainer uses a scrollbar instead of an item count hint', async () => {
  const { lastFrame } = await renderInAct(
    <MenuContainer
      items={Array.from({ length: 15 }, (_, index) => String(index))}
      selectedIndex={0}
      scrollOffset={2}
      maxHeight={10}
      renderItem={(item) => <Text key={item}>{item}</Text>}
    />,
  );

  const output = lastFrame()!;
  expect(output).not.toContain('more');
  expect(output).toContain('┃');
});

it.sequential('MenuScrollbar moves its thumb and is bounded for short lists', async () => {
  const top = await renderInAct(<MenuScrollbar itemCount={15} scrollOffset={0} maxHeight={10} />);
  const bottom = await renderInAct(<MenuScrollbar itemCount={15} scrollOffset={5} maxHeight={10} />);
  const short = await renderInAct(<MenuScrollbar itemCount={5} scrollOffset={0} maxHeight={10} />);
  const firstThumbLine = (frame: string) => frame.split('\n').findIndex((line) => line.includes('┃'));

  expect(firstThumbLine(top.lastFrame()!)).toBe(0);
  expect(firstThumbLine(bottom.lastFrame()!)).toBeGreaterThan(firstThumbLine(top.lastFrame()!));
  expect(
    short
      .lastFrame()!
      .split('\n')
      .filter((line) => line.includes('┃')),
  ).toHaveLength(10);
});

it.sequential('MenuContainer omits the scrollbar when all items fit', async () => {
  const { lastFrame } = await renderInAct(
    <MenuContainer items={['a', 'b']} selectedIndex={0} renderItem={(item) => <Text key={item}>{item}</Text>} />,
  );

  expect(lastFrame()!).not.toContain('┃');
});

it.sequential('MenuContainer passes isInactive to renderItem and identifies them correctly', async () => {
  const items = ['a', 'b', 'c'];
  const renderedInactiveArgs: boolean[] = [];

  const { lastFrame } = await renderInAct(
    <MenuContainer
      items={items}
      selectedIndex={0}
      borderColor="magenta"
      isInactive={(item) => item === 'b'}
      renderItem={(item, _index, _isSelected, isInactive) => {
        renderedInactiveArgs.push(isInactive);
        return <Text key={item}>{item}</Text>;
      }}
    />,
  );

  const output = lastFrame();
  expect(output).toBeTruthy();
  expect(renderedInactiveArgs).toEqual([false, true, false]);
});

// Class guard: the marker is an inflexible 2-cell gutter. Yoga steals
// shrinkable cells first on narrow terminals, so a bare-Text marker
// collapses to `❯/` and then vanishes. Every menu row relies on this.
for (const width of [80, 24]) {
  it.sequential(`SelectionMarker keeps its two-cell gutter at ${width} cols`, async () => {
    const { lastFrame } = await renderInAct(
      <Box width={width}>
        <Box flexDirection="column" width="100%">
          <Box width="100%" flexDirection="row">
            <SelectionMarker selected={true} />
            <Box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
              <Text>selected-row-label-that-keeps-going-and-going-and-going</Text>
            </Box>
          </Box>
          <Box width="100%" flexDirection="row">
            <SelectionMarker selected={false} />
            <Box flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0}>
              <Text>unselected-row-label</Text>
            </Box>
          </Box>
        </Box>
      </Box>,
    );

    const lines = toVisibleText(lastFrame()!).split('\n');
    const selectedLine = lines.find((line) => line.includes('selected-row-label'));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toMatch(/❯ selected-row-label/);
    const unselectedLine = lines.find((line) => line.includes('unselected-row-label'));
    expect(unselectedLine).toBeDefined();
    expect(unselectedLine).not.toContain('❯');
  });
}

it.sequential('MenuContainer handles inactive items that return Box components without crashing', async () => {
  const items = ['a', 'b', 'c'];

  const { lastFrame } = await renderInAct(
    <MenuContainer
      items={items}
      selectedIndex={0}
      borderColor="magenta"
      isInactive={(item) => item === 'b'}
      renderItem={(item, _index, _isSelected, isInactive) => (
        <Box key={item}>
          <Text color={isInactive ? 'gray' : 'white'}>{item}</Text>
        </Box>
      )}
    />,
  );

  const output = lastFrame();
  expect(output).toBeTruthy();
  expect(output!.includes('a')).toBe(true);
  expect(output!.includes('b')).toBe(true);
  expect(output!.includes('c')).toBe(true);
});
