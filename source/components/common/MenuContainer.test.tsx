import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import { Box, Text } from 'ink';
import { MenuContainer } from './MenuContainer.js';

test.serial('MenuContainer renders items', async (t) => {
  const { lastFrame } = await renderInAct(
    <MenuContainer
      items={['a', 'b', 'c']}
      selectedIndex={0}
      borderColor="magenta"
      renderItem={(item) => <Text key={item}>{item}</Text>}
    />,
    t,
  );

  const output = lastFrame();
  t.truthy(output);
  t.true(output!.includes('a'));
  t.true(output!.includes('b'));
  t.true(output!.includes('c'));
});

test.serial('MenuContainer passes isInactive to renderItem and identifies them correctly', async (t) => {
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
    t,
  );

  const output = lastFrame();
  t.truthy(output);
  t.deepEqual(renderedInactiveArgs, [false, true, false]);
});

test.serial('MenuContainer handles inactive items that return Box components without crashing', async (t) => {
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
    t,
  );

  const output = lastFrame();
  t.truthy(output);
  t.true(output!.includes('a'));
  t.true(output!.includes('b'));
  t.true(output!.includes('c'));
});
