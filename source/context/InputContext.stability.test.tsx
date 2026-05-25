// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act, useEffect } from 'react';
import { render } from 'ink-testing-library';
import { InputProvider, useInputActions, useInputContext } from './InputContext.js';

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

  await act(async () => {
    render(
      <InputProvider>
        <ActionsProbe />
        <Trigger />
      </InputProvider>,
    );
  });

  t.true(actionsSeen.length >= 1);
  t.is(actionsSeen[0], actionsSeen[actionsSeen.length - 1]);
});
