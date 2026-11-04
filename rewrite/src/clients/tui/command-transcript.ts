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
  const [entries, setEntries] = useState<readonly { message: Message; after?: string; before?: string }[]>([]);
  const append = (text: string, plain: boolean | 'system' = false) => {
    const after = state.timeline?.at(-1)?.id;
    // A cancelled turn can drop its last row (an unstarted call); the row before it keeps the place.
    const before = state.timeline?.at(-2)?.id;
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
        before,
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
    const found = timeline.findIndex((item) => item.id === entry.after || item.id === replacement);
    const fallback =
      found < 0 && entry.before !== undefined ? timeline.findIndex((item) => item.id === entry.before) : -1;
    const anchor = entry.after === undefined ? undefined : found >= 0 ? found : fallback;
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
  const last = transcript.state.timeline?.at(-1);
  return {
    ...viewport,
    /** The transcript ends with a local system line (`Stopped`), which legacy follows with two blank rows, not three. */
    endsWithSystemLine:
      last?.kind === 'message' &&
      transcript.state.messages.find((message) => message.id === last.id)?.localSystem === true,
    appendCommandOutput: transcript.append,
    showMessage(message: string, command: string, notice: (value: string) => void): void {
      if (command.trim() !== '/help') notice(message);
      else if (state.activeTurnId) viewport.setHelp(message);
      else transcript.append(helpForScrollback(message), true);
    },
  };
}
