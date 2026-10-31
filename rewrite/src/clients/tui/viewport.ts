import { useState } from 'react';
import { useInput } from 'ink';
import type { Message } from './state.js';

/** Page through message history; null anchor follows the live end of the transcript. */
export function useTranscriptViewport(messages: readonly Message[], rows: number) {
  const [anchor, setAnchor] = useState<string | null>(null);
  const pageSize = Math.max(1, Math.floor((rows - 8) / 4));
  const anchorIndex = anchor === null ? -1 : messages.findIndex(message => message.id === anchor);
  const end = anchorIndex < 0 ? messages.length : anchorIndex + 1;
  const start = Math.max(0, end - pageSize);
  const live = anchorIndex < 0;
  useInput((_input, key) => {
    if (key.pageUp && start > 0) setAnchor(messages[start - 1].id);
    if (key.pageDown && !live) {
      const nextEnd = Math.min(messages.length, end + pageSize);
      setAnchor(nextEnd === messages.length ? null : messages[nextEnd - 1].id);
    }
  });
  return { messages: messages.slice(start, end), start, end, total: messages.length, live };
}
