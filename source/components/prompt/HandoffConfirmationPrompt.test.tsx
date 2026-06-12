import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import HandoffConfirmationPrompt from './HandoffConfirmationPrompt.js';

test('HandoffConfirmationPrompt renders question and choices', (t) => {
  const { lastFrame } = render(
    <HandoffConfirmationPrompt onConfirm={() => {}} onDecline={() => {}} onCancel={() => {}} />,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('📋 Change model?'));
  t.true(output.includes('Yes'));
  t.true(output.includes('No'));
});
