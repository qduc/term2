// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { useInputHistory } from './use-input-history.js';

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

test('useInputHistory preserves image attachments when navigating back to the draft', async (t) => {
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

  await act(async () => {
    render(<HookHarness historyService={historyService} />);
  });

  t.truthy(hookControls);

  let recalled = null as ReturnType<typeof useInputHistory>['navigateUp'] extends (...args: any[]) => infer R
    ? R
    : never;
  await act(async () => {
    recalled = hookControls!.navigateUp({ text: 'draft note', images: [draftImage] });
  });
  t.deepEqual(recalled, { text: 'Look at this', images: [recalledImage] });

  let restored = null as ReturnType<typeof useInputHistory>['navigateDown'] extends (...args: any[]) => infer R
    ? R
    : never;
  await act(async () => {
    restored = hookControls!.navigateDown();
  });
  t.deepEqual(restored, { text: 'draft note', images: [draftImage] });
});
