// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { MenuContainer } from './MenuContainer.js';

test('MenuContainer renders items', (t) => {
  const items = ['a', 'b', 'c'];
  let lastFrame: () => string | undefined;
  let unmount: () => void;

  act(() => {
    const rendered = render(
      <MenuContainer
        items={items}
        selectedIndex={0}
        borderColor="magenta"
        renderItem={(item) => <Text key={item}>{item}</Text>}
      />,
    );
    lastFrame = rendered.lastFrame;
    unmount = rendered.unmount;
  });

  const output = lastFrame!();
  t.truthy(output);
  t.true(output!.includes('a'));
  t.true(output!.includes('b'));
  t.true(output!.includes('c'));

  act(() => {
    unmount();
  });
});

test('MenuContainer passes isInactive to renderItem and identifies them correctly', (t) => {
  const items = ['a', 'b', 'c'];
  const renderedInactiveArgs: boolean[] = [];
  let lastFrame: () => string | undefined;
  let unmount: () => void;

  act(() => {
    const rendered = render(
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
    lastFrame = rendered.lastFrame;
    unmount = rendered.unmount;
  });

  const output = lastFrame!();
  t.truthy(output);
  // Verify that the second item ('b') was passed isInactive = true
  t.deepEqual(renderedInactiveArgs, [false, true, false]);

  act(() => {
    unmount();
  });
});

test('MenuContainer handles inactive items that return Box components without crashing', (t) => {
  const items = ['a', 'b', 'c'];
  let lastFrame: () => string | undefined;
  let unmount: () => void;

  act(() => {
    const rendered = render(
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
    lastFrame = rendered.lastFrame;
    unmount = rendered.unmount;
  });

  const output = lastFrame!();
  t.truthy(output);
  t.true(output!.includes('a'));
  t.true(output!.includes('b'));
  t.true(output!.includes('c'));

  act(() => {
    unmount();
  });
});
