import test from 'ava';
import React from 'react';
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

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  render(<HookHarness historyService={historyService} />);

  t.truthy(hookControls);

  const recalled = hookControls!.navigateUp({ text: 'draft note', images: [draftImage] });
  t.deepEqual(recalled, { text: 'Look at this', images: [recalledImage] });

  await flush();

  const restored = hookControls!.navigateDown();
  t.deepEqual(restored, { text: 'draft note', images: [draftImage] });
});
