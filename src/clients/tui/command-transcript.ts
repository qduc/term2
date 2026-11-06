import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Message, TuiState } from './state.js';
import type { ShellResult } from './integration.js';
import { useTerminalSize } from './terminal.js';
import { useTranscriptViewport } from './viewport.js';

/** Local command output belongs in the visible transcript, not provider history. */
export function useCommandTranscript(state: TuiState): {
  state: TuiState;
  append(text: string, plain?: boolean | 'system', shell?: Message['localShell']): void;
  count: number;
} {
  const [entries, setEntries] = useState<
    readonly { message: Message; after?: string; before: readonly string[]; idle?: true }[]
  >([]);
  const append = (text: string, plain: boolean | 'system' = false, shell?: Message['localShell']) => {
    const after = state.timeline?.at(-1)?.id;
    // A cancelled turn can drop its last rows (its in-flight step); the nearest earlier row still shown keeps the place.
    const before = (state.timeline ?? [])
      .slice(-8, -1)
      .map((item) => item.id)
      .reverse();
    setEntries((previous) => [
      ...previous,
      {
        message: {
          id: `local-command-${crypto.randomUUID()}`,
          role: 'assistant',
          text,
          ...(plain === 'system' ? { localSystem: true as const } : plain ? { localHelp: true as const } : {}),
          ...(shell ? { localShell: shell } : {}),
        },
        after,
        before,
        // Only an idle anchor is settled history; a turn's draft is replaced by its final message.
        ...(state.activeTurnId ? {} : { idle: true as const }),
      },
    ]);
  };
  // Memoised on the history lists, so a streamed token does not hand every history scan below a new list.
  const merged = useMemo(() => {
    if (!entries.length) return null;
    const timeline = [
      ...(state.timeline ?? state.messages.map((message) => ({ kind: 'message' as const, id: message.id }))),
    ];
    const shown: (typeof entries)[number][] = [];
    for (const entry of entries) {
      // A live draft can be replaced by its final message after the command runs.
      // Follow that explicit wire identity rather than sending output to the top.
      const replacement =
        entry.after === undefined
          ? undefined
          : state.messages.find((message) => message.replacesDraftId === entry.after)?.id;
      const found = timeline.findIndex((item) => item.id === entry.after || item.id === replacement);
      let fallback = -1;
      for (const id of found < 0 ? entry.before : []) {
        fallback = timeline.findIndex((item) => item.id === id);
        if (fallback >= 0) break;
      }
      const anchor = entry.after === undefined ? undefined : found >= 0 ? found : fallback;
      // Legacy's rewind truncates its message list, system lines included: a line whose anchor left the
      // history (rewound or retried away) goes with it.
      if (anchor !== undefined && anchor < 0 && state.timeline && entry.idle) continue;
      shown.push(entry);
      let index = anchor === undefined ? 0 : anchor < 0 ? timeline.length : anchor + 1;
      while (index < timeline.length && entries.some((other) => other.message.id === timeline[index]?.id)) index++;
      timeline.splice(index, 0, { kind: 'message', id: entry.message.id });
    }
    return { messages: [...state.messages, ...shown.map((entry) => entry.message)], timeline };
  }, [entries, state.timeline, state.messages]);
  if (!merged) return { state, append, count: 0 };
  return {
    state: { ...state, ...merged },
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
  options: { readonly transitionNotices?: readonly string[]; readonly redrawKey?: string } = {},
  showReasoning = true,
) {
  const { columns, rows } = useTerminalSize();
  const transcript = useCommandTranscript(state);
  // A changed redraw key repaints the transcript like a history change does.
  const [redraws, setRedraws] = useState(0);
  const drawnKey = useRef(options.redrawKey);
  useEffect(() => {
    if (drawnKey.current === options.redrawKey) return;
    drawnKey.current = options.redrawKey;
    setRedraws((count) => count + 1);
  }, [options.redrawKey]);
  // A session switch's notice ("Resumed conversation: <id>") follows the replayed history, where legacy adds
  // it: once, on the switched-to session's mount (its connection already carries the snapshot).
  useEffect(() => {
    for (const notice of options.transitionNotices ?? []) transcript.append(notice, true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const viewport = useTranscriptViewport(
    transcript.state,
    columns,
    rows - headerHeight,
    active,
    header,
    (historyRevision ?? 0) + redraws,
    showReasoning,
  );
  return {
    ...viewport,
    /**
     * Rows above the bottom area, as legacy's layout: with no live rows, MessageList's spacer and margin and
     * BottomArea's margin (3); under live rows the live Transcript's own bottom padding stands in for the spacer.
     */
    bottomMargin: viewport.text.trim() ? 1 : 3,
    appendCommandOutput: transcript.append,
    /** Legacy addShellMessage: a `!` command's result is a command row in the transcript. */
    appendShell(result: ShellResult): void {
      const success = !result.timedOut && result.exitCode === 0;
      const failureReason = result.timedOut
        ? 'timeout'
        : result.exitCode == null
        ? 'error'
        : result.exitCode !== 0
        ? `exit ${result.exitCode}`
        : undefined;
      transcript.append('', false, {
        command: result.command,
        output: result.output,
        success,
        ...(failureReason ? { failureReason } : {}),
      });
    },
    /** A command's message is a legacy system line in the transcript; `/help` during a turn takes the viewport. */
    showMessage(message: string, command: string): void {
      if (command.trim() === '/help' && state.activeTurnId) viewport.setHelp(message);
      else transcript.append(message, true);
    },
  };
}
