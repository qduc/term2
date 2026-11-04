import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Message, TuiState } from './state.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';

/** Local command output belongs in the visible transcript, not provider history. */
export function useCommandTranscript(state: TuiState): {
  state: TuiState;
  append(text: string, plain?: boolean): void;
  count: number;
} {
  const [entries, setEntries] = useState<readonly { message: Message; after?: string }[]>([]);
  const append = (text: string, plain = false) => {
    const after = state.timeline?.at(-1)?.id;
    setEntries((previous) => [
      ...previous,
      {
        message: {
          id: `local-command-${crypto.randomUUID()}`,
          role: 'assistant',
          text,
          ...(plain ? { localHelp: true as const } : {}),
        },
        after,
      },
    ]);
  };
  if (!entries.length) return { state, append, count: 0 };
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
    count: entries.length,
  };
}

export function useCommandTranscriptViewport(
  state: TuiState,
  headerHeight: number,
  active: boolean,
  header?: ReactNode,
  historyRevision?: number,
  options: { readonly transitionNotice?: string } = {},
) {
  const { columns, rows } = useTerminalSize();
  const transcript = useCommandTranscript(state);
  // A session switch's notice ("Resumed conversation: <id>") follows the replayed history, where legacy adds
  // it: once, on the switched-to session's mount (its connection already carries the snapshot).
  useEffect(() => {
    if (options.transitionNotice) transcript.append(options.transitionNotice, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const viewport = useTranscriptViewport(
    transcript.state,
    columns,
    rows - headerHeight,
    active,
    header,
    historyRevision,
  );
  // Legacy's MessageList commits a finished row to Static only on its next render after the row appears, unless the
  // row was live first. A system line added while idle, and every row after a redraw (resize, rewind), therefore
  // sit in its live region until the transcript next changes, and the spacer below Static is absent.
  const deferral = useRef({
    timeline: state.timeline,
    local: transcript.count,
    epoch: viewport.epoch,
    deferred: false,
  });
  const seen = deferral.current;
  if (viewport.epoch !== seen.epoch || (transcript.count > seen.local && !state.activeTurnId)) seen.deferred = true;
  else if (seen.timeline !== state.timeline || transcript.count > seen.local) seen.deferred = false;
  Object.assign(seen, { timeline: state.timeline, local: transcript.count, epoch: viewport.epoch });
  return {
    ...viewport,
    /**
     * Rows above the bottom area, as legacy's layout: with no live rows, MessageList's spacer and margin and
     * BottomArea's margin (3); under live rows the live Transcript's own bottom padding stands in for the spacer.
     */
    bottomMargin: viewport.text.trim() ? 1 : seen.deferred && !state.activeTurnId ? 2 : 3,
    appendCommandOutput: transcript.append,
    /** A command's message is a legacy system line in the transcript; `/help` during a turn takes the viewport. */
    showMessage(message: string, command: string): void {
      if (command.trim() === '/help' && state.activeTurnId) viewport.setHelp(message);
      else transcript.append(message, true);
    },
  };
}
