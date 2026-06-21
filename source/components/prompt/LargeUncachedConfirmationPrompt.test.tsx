// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
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

it.sequential('LargeUncachedConfirmationPrompt renders prompt and choices', async () => {
  const { lastFrame } = await renderInAct(
    <LargeUncachedConfirmationPrompt usage={{ prompt_tokens: 72_100 }} onConfirm={() => {}} onDecline={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Send 72,100 tokens anyway?')).toBe(true);
  expect(output.includes('may miss prompt cache')).toBe(true);
  expect(output.includes('Send')).toBe(true);
  expect(output.includes('Cancel')).toBe(true);
});

it.sequential('LargeUncachedConfirmationPrompt declines on n input', async () => {
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

  const { lastFrame, stdin } = await renderInAct(<Harness />);

  await flushReactUpdates(2);
  await pressDecline(stdin);

  expect((lastFrame() ?? '').includes('Send 72,100 tokens anyway?')).toBe(true);
  expect(declined).toBe(true);
});
