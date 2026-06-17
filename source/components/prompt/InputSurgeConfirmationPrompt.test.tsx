// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import InputSurgeConfirmationPrompt from './InputSurgeConfirmationPrompt.js';

it.sequential('InputSurgeConfirmationPrompt renders prompt and choices', async () => {
  const { lastFrame, unmount } = await renderInAct(
    <InputSurgeConfirmationPrompt reason="Outgoing message count jumped" onConfirm={() => {}} onDecline={() => {}} />,
  );

  const output = lastFrame() ?? '';
  expect(output.includes('Input Surge Warning: Outgoing message count jumped')).toBe(true);
  expect(output.includes('Send request anyway?')).toBe(true);
  expect(output.includes('Send anyway')).toBe(true);
  expect(output.includes('Cancel')).toBe(true);
  act(() => {
    unmount();
  });
});

it.sequential('InputSurgeConfirmationPrompt declines on n input', async () => {
  let declined = false;

  const { lastFrame, stdin, unmount } = await renderInAct(
    <InputSurgeConfirmationPrompt
      reason="Outgoing message count jumped"
      onConfirm={() => {}}
      onDecline={() => {
        declined = true;
      }}
    />,
  );

  act(() => {
    stdin.write('n');
  });
  await new Promise((resolve) => setImmediate(resolve));

  expect((lastFrame() ?? '').includes('Input Surge Warning: Outgoing message count jumped')).toBe(true);
  expect(declined).toBe(true);
  act(() => {
    unmount();
  });
});
