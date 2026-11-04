import { useState, type ReactNode } from 'react';
import type { Message, TuiState } from './state.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';
import { helpForScrollback } from './slash-commands.js';

/** Local command output belongs in the visible transcript, not provider history. */
export function useCommandTranscript(state: TuiState): {
  state: TuiState;
  append(text: string, plain?: boolean | 'system'): void;
} {
  const [entries, setEntries] = useState<readonly { message: Message; after?: string }[]>([]);
  const append = (text: string, plain: boolean | 'system' = false) => {
    const after = state.timeline?.at(-1)?.id;
    setEntries((previous) => [
      ...previous,
      {
        message: {
          id: `local-command-${crypto.randomUUID()}`,
          role: 'assistant',
          text,
          ...(plain === 'system' ? { localSystem: true as const } : plain ? { localHelp: true as const } : {}),
        },
        after,
      },
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

export function useCommandTranscriptViewport(
  state: TuiState,
  headerHeight: number,
  active: boolean,
  header?: ReactNode,
  historyRevision?: number,
) {
  const { columns, rows } = useTerminalSize();
  const transcript = useCommandTranscript(state);
  const viewport = useTranscriptViewport(
    transcript.state,
    columns,
    rows - headerHeight,
    active,
    header,
    historyRevision,
  );
  return {
    ...viewport,
    appendCommandOutput: transcript.append,
    showMessage(message: string, command: string, notice: (value: string) => void): void {
      if (command.trim() !== '/help') notice(message);
      else if (state.activeTurnId) viewport.setHelp(message);
      else transcript.append(helpForScrollback(message), true);
    },
  };
}
