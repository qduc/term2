// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import ConfirmPrompt from './ConfirmPrompt.js';
import { GLYPH_WARNING } from '../theme.js';

type Outcome = 'confirm' | 'decline' | 'cancel';

const renderPrompt = async (props: Partial<React.ComponentProps<typeof ConfirmPrompt>> = {}) => {
  const outcomes: Outcome[] = [];
  const rendered = await renderInAct(
    <ConfirmPrompt
      question="Proceed?"
      onConfirm={() => outcomes.push('confirm')}
      onDecline={() => outcomes.push('decline')}
      onCancel={() => outcomes.push('cancel')}
      {...props}
    />,
  );
  const press = async (input: string) => {
    await act(async () => {
      rendered.stdin.write(input);
    });
    await act(async () => {
      await new Promise((resolve) => setImmediate(resolve));
    });
  };
  return { ...rendered, outcomes, press };
};

it.sequential('ConfirmPrompt renders question, default Yes/No options, and the shared key legend', async () => {
  const { lastFrame, unmount } = await renderPrompt();
  const output = lastFrame() ?? '';
  expect(output).toContain('Proceed?');
  expect(output).toContain('❯ Yes');
  expect(output).toContain('  No');
  expect(output).toContain('↑↓ navigate │ ⏎ select │ y/n answer │ esc cancel');
  act(() => unmount());
});

it.sequential('ConfirmPrompt prefixes a warning line with the theme warning glyph', async () => {
  const { lastFrame, unmount } = await renderPrompt({ warning: 'This clears the session.' });
  expect(lastFrame()).toContain(`${GLYPH_WARNING} This clears the session.`);
  act(() => unmount());
});

it.sequential('ConfirmPrompt honours custom labels and the default selection', async () => {
  const { lastFrame, unmount } = await renderPrompt({ confirmLabel: 'Send', declineLabel: 'Cancel', defaultIndex: 1 });
  const output = lastFrame() ?? '';
  expect(output).toContain('  Send');
  expect(output).toContain('❯ Cancel');
  act(() => unmount());
});

it.sequential('ConfirmPrompt Enter answers the highlighted option after arrow navigation', async () => {
  const { press, outcomes, unmount } = await renderPrompt();
  await press('\u001B[B');
  await press('\r');
  expect(outcomes).toEqual(['decline']);
  act(() => unmount());
});

it.sequential('ConfirmPrompt y and n answer directly in either case', async () => {
  const { press, outcomes, unmount } = await renderPrompt();
  await press('Y');
  await press('n');
  expect(outcomes).toEqual(['confirm', 'decline']);
  act(() => unmount());
});

it.sequential('ConfirmPrompt Escape cancels', async () => {
  const { press, outcomes, unmount } = await renderPrompt();
  await press('\u001B');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(outcomes).toEqual(['cancel']);
  act(() => unmount());
});
