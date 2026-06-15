// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import InputSurgeConfirmationPrompt from './InputSurgeConfirmationPrompt.js';

test.serial('InputSurgeConfirmationPrompt renders prompt and choices', async (t) => {
  const { lastFrame, unmount } = await renderInAct(
    <InputSurgeConfirmationPrompt reason="Outgoing message count jumped" onConfirm={() => {}} onDecline={() => {}} />,
    t,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('Input Surge Warning: Outgoing message count jumped'));
  t.true(output.includes('Send request anyway?'));
  t.true(output.includes('Send anyway'));
  t.true(output.includes('Cancel'));
  act(() => {
    unmount();
  });
});

test.serial('InputSurgeConfirmationPrompt declines on n input', async (t) => {
  let declined = false;

  const { lastFrame, stdin, unmount } = await renderInAct(
    <InputSurgeConfirmationPrompt
      reason="Outgoing message count jumped"
      onConfirm={() => {}}
      onDecline={() => {
        declined = true;
      }}
    />,
    t,
  );

  act(() => {
    stdin.write('n');
  });
  await new Promise((resolve) => setImmediate(resolve));

  t.true((lastFrame() ?? '').includes('Input Surge Warning: Outgoing message count jumped'));
  t.true(declined);
  act(() => {
    unmount();
  });
});
