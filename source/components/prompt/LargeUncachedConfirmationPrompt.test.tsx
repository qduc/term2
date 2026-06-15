// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import LargeUncachedConfirmationPrompt from './LargeUncachedConfirmationPrompt.js';

const flushReactUpdates = async (iterations = 1) => {
  await act(async () => {
    for (let i = 0; i < iterations; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
};

const pressDecline = async (stdin: { write: (input: string) => void }) => {
  await act(async () => {
    stdin.write('n');
  });

  await flushReactUpdates(3);
};

test.serial('LargeUncachedConfirmationPrompt renders prompt and choices', async (t) => {
  const { lastFrame } = await renderInAct(
    <LargeUncachedConfirmationPrompt usage={{ prompt_tokens: 72_100 }} onConfirm={() => {}} onDecline={() => {}} />,
    t,
  );

  const output = lastFrame() ?? '';
  t.true(output.includes('Send 72,100 tokens anyway?'));
  t.true(output.includes('may miss prompt cache'));
  t.true(output.includes('Send'));
  t.true(output.includes('Cancel'));
});

test.serial('LargeUncachedConfirmationPrompt declines on n input', async (t) => {
  let declined = false;

  const Harness = () => {
    return (
      <LargeUncachedConfirmationPrompt
        usage={{ prompt_tokens: 72_100 }}
        onConfirm={() => {}}
        onDecline={() => {
          declined = true;
        }}
      />
    );
  };

  const { lastFrame, stdin } = await renderInAct(<Harness />, t);

  await flushReactUpdates(2);
  await pressDecline(stdin);

  t.true((lastFrame() ?? '').includes('Send 72,100 tokens anyway?'));
  t.true(declined);
});
