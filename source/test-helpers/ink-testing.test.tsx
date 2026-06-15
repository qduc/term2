// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { renderInAct, rerenderInAct, toVisibleText } from './ink-testing.js';

test('toVisibleText removes terminal styling without changing visible content', (t) => {
  t.is(toVisibleText('\u001B[32m▶ \u001B[1magent.model\u001B[0m'), '▶ agent.model');
});

test.serial('renderInAct renders ink output inside act', async (t) => {
  const { lastFrame } = await renderInAct(
    <Box>
      <Text>Hello</Text>
    </Box>,
    t,
  );

  t.is(lastFrame(), 'Hello');
});

test.serial('rerenderInAct updates ink output inside act', async (t) => {
  const view = await renderInAct(<Text>Before</Text>, t);

  await rerenderInAct(view, <Text>After</Text>);

  t.is(view.lastFrame(), 'After');
});

let cleanupCount = 0;

test.serial('renderInAct registers an act-wrapped teardown when given the test context', async (t) => {
  const TestComponent = () => {
    useEffect(
      () => () => {
        cleanupCount += 1;
      },
      [],
    );

    return <Text>Hello</Text>;
  };

  await renderInAct(<TestComponent />, t);
  t.is(cleanupCount, 0);
});

test.serial('renderInAct runs the registered teardown after the test', (t) => {
  t.is(cleanupCount, 1);
});
