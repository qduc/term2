// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { useInputHistory } from './use-input-history.js';
import { renderInAct } from '../test-helpers/ink-testing.js';

type TestHistoryService = {
  getTurns: () => Array<{
    text: string;
    images?: Array<{ id: string; data: string; mimeType: string; byteSize: number; displayNumber: number }>;
  }>;
  addMessage: (message: any) => void;
  clear: () => void;
  getMessages: () => string[];
};

let hookControls: ReturnType<typeof useInputHistory> | null = null;

const HookHarness = ({ historyService }: { historyService: TestHistoryService }) => {
  hookControls = useInputHistory(historyService as any);
  return null;
};

it.sequential('useInputHistory preserves image attachments when navigating back to the draft', async () => {
  hookControls = null;

  const draftImage = {
    id: 'draft-img',
    data: 'abc123',
    mimeType: 'image/png',
    byteSize: 3,
    displayNumber: 1,
  };
  const recalledImage = {
    id: 'recalled-img',
    data: 'def456',
    mimeType: 'image/png',
    byteSize: 3,
    displayNumber: 1,
  };

  const historyService: TestHistoryService = {
    getTurns: () => [{ text: 'Look at this', images: [recalledImage] }],
    addMessage: () => {},
    clear: () => {},
    getMessages: () => ['Look at this'],
  };

  await renderInAct(<HookHarness historyService={historyService} />);

  expect(hookControls).toBeTruthy();

  let recalled = null as ReturnType<typeof useInputHistory>['navigateUp'] extends (...args: any[]) => infer R
    ? R
    : never;
  await act(async () => {
    recalled = hookControls!.navigateUp({ text: 'draft note', images: [draftImage] });
  });
  expect(recalled).toEqual({ text: 'Look at this', images: [recalledImage] });

  let restored = null as ReturnType<typeof useInputHistory>['navigateDown'] extends (...args: any[]) => infer R
    ? R
    : never;
  await act(async () => {
    restored = hookControls!.navigateDown();
  });
  expect(restored).toEqual({ text: 'draft note', images: [draftImage] });
});
