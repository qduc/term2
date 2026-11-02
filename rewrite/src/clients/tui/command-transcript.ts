import { useState } from 'react';
import type { Message, TuiState } from './state.js';
import { useTranscriptViewport } from './viewport.js';

/** Local command output belongs in the visible transcript, not provider history. */
export function useCommandTranscript(state: TuiState): { state: TuiState; append(text: string): void } {
  const [entries, setEntries] = useState<readonly { message: Message; after?: string }[]>([]);
  const append = (text: string) => {
    const after = state.timeline?.at(-1)?.id;
    setEntries((previous) => [
      ...previous,
      { message: { id: `local-command-${crypto.randomUUID()}`, role: 'assistant', text }, after },
    ]);
  };
  if (!entries.length) return { state, append };
  const timeline = [
    ...(state.timeline ?? state.messages.map((message) => ({ kind: 'message' as const, id: message.id }))),
  ];
  for (const entry of entries) {
    // A live draft can be replaced by its final message after the command runs.
    // Follow that explicit wire identity rather than sending output to the top.
    const replacement =
      entry.after === undefined
        ? undefined
        : state.messages.find((message) => message.replacesDraftId === entry.after)?.id;
    const anchor =
      entry.after === undefined
        ? undefined
        : timeline.findIndex((item) => item.id === entry.after || item.id === replacement);
    let index = anchor === undefined ? 0 : anchor < 0 ? timeline.length : anchor + 1;
    while (index < timeline.length && entries.some((other) => other.message.id === timeline[index]?.id)) index++;
    timeline.splice(index, 0, { kind: 'message', id: entry.message.id });
  }
  return {
    state: { ...state, messages: [...state.messages, ...entries.map((entry) => entry.message)], timeline },
    append,
  };
}

export function useCommandTranscriptViewport(state: TuiState, columns: number, rows: number, active: boolean) {
  const transcript = useCommandTranscript(state);
  return { ...useTranscriptViewport(transcript.state, columns, rows, active), appendCommandOutput: transcript.append };
}
