// @ts-ignore
global.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { Box, Text } from 'ink';
import { MenuContainer } from './MenuContainer.js';

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
