// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import HandoffConfirmationPrompt from './HandoffConfirmationPrompt.js';

it('HandoffConfirmationPrompt renders question and choices', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(<HandoffConfirmationPrompt onConfirm={() => {}} onDecline={() => {}} onCancel={() => {}} />);
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  const output = lastFrame() ?? '';
  expect(output.includes('📋 Change model?')).toBe(true);
  expect(output.includes('Yes')).toBe(true);
  expect(output.includes('No')).toBe(true);

  await act(async () => {
    unmount();
  });
});
