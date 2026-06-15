// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { useEffect } from 'react';
import { InputProvider, useInputActions, useInputContext } from './InputContext.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

test.serial('useInputActions remains stable across input updates', async (t) => {
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

  await renderInAct(
    <InputProvider>
      <ActionsProbe />
      <Trigger />
    </InputProvider>,
    t,
  );

  t.true(actionsSeen.length >= 1);
  t.is(actionsSeen[0], actionsSeen[actionsSeen.length - 1]);
});
