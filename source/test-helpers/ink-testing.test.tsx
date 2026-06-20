// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { renderInAct, rerenderInAct, toVisibleText } from './ink-testing.js';

it('toVisibleText removes terminal styling without changing visible content', () => {
  expect(toVisibleText('\u001B[32m▶ \u001B[1magent.model\u001B[0m')).toBe('▶ agent.model');
});

it.sequential('renderInAct renders ink output inside act', async () => {
  const { lastFrame } = await renderInAct(
    <Box>
      <Text>Hello</Text>
    </Box>,
  );

  expect(lastFrame()).toBe('Hello');
});

it.sequential('rerenderInAct updates ink output inside act', async () => {
  const view = await renderInAct(<Text>Before</Text>);

  await rerenderInAct(view, <Text>After</Text>);

  expect(view.lastFrame()).toBe('After');
});

let cleanupCount = 0;

it.sequential('renderInAct registers an act-wrapped teardown when given the test context', async () => {
  const TestComponent = () => {
    useEffect(
      () => () => {
        cleanupCount += 1;
      },
      [],
    );

    return null;
  };

  await renderInAct(<TestComponent />);
  expect(cleanupCount).toBe(0);
});

it.sequential('renderInAct runs the registered teardown after the test', async () => {
  expect(cleanupCount).toBe(1);
});
