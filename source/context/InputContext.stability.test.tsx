import test from 'ava';
import React, { useEffect } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputActions, useInputContext } from './InputContext.js';

const waitForTick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('useInputActions remains stable across input updates', async (t) => {
  const actionsSeen: any[] = [];

  const ActionsProbe = () => {
    const actions = useInputActions();
    actionsSeen.push(actions);
    return null;
  };

  const Trigger = () => {
    const { setInput } = useInputContext();
    useEffect(() => {
      setInput('first');
      setInput('second');
    }, [setInput]);
    return null;
  };

  render(
    <InputProvider>
      <ActionsProbe />
      <Trigger />
    </InputProvider>,
  );

  await waitForTick();

  t.is(actionsSeen.length, 1);
  t.is(actionsSeen[0], actionsSeen[actionsSeen.length - 1]);
});
