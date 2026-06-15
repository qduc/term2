// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import HandoffConfirmationPrompt from './HandoffConfirmationPrompt.js';

test('HandoffConfirmationPrompt renders question and choices', async (t) => {
  const { lastFrame } = await renderInAct(
    <HandoffConfirmationPrompt onConfirm={() => {}} onDecline={() => {}} onCancel={() => {}} />,
    t,
  );
  const output = lastFrame() ?? '';
  t.true(output.includes('📋 Change model?'));
  t.true(output.includes('Yes'));
  t.true(output.includes('No'));
});
