// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React, { useEffect } from 'react';
import { InputProvider, useInputActions, useInputContext } from './InputContext.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

it.sequential('useInputActions remains stable across input updates', async () => {
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
  );

  expect(actionsSeen.length >= 1).toBe(true);
  expect(actionsSeen[0]).toBe(actionsSeen[actionsSeen.length - 1]);
});
