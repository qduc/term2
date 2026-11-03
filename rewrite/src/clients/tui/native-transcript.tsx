import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text } from 'ink';
import { reportsFailure } from './tool-view.js';
import type { Message, ToolView, TuiState } from './state.js';
import { Transcript } from './views.js';
import { failedShellGroups, FailedShellSummary } from './failed-shell-summary.js';
import { findMarkdownCommitOffset } from './presentation/utils/markdown-commit-frontier.js';

type Row = {
  readonly key: string;
  readonly message?: Message;
  readonly tool?: ToolView;
  readonly header?: React.ReactNode;
  /** Settled prefix of a streaming draft that is already in scrollback. */
  readonly draftId?: string;
  /** The exact draft text this row covers; the row shows it without trailing blank lines. */
  readonly draftText?: string;
};

const draftPrefixRows = (rows: readonly Row[], draftId: string) => rows.filter((row) => row.draftId === draftId);
const prefixLength = (rows: readonly Row[], draftId: string) =>
  draftPrefixRows(rows, draftId).reduce((sum, row) => sum + row.draftText!.length, 0);
/** Drop the part of a finalized reply that scrollback already shows. */
const withoutPrefix = (message: Message, rows: readonly Row[]): Message => {
  if (!message.replacesDraftId) return message;
  const prefix = draftPrefixRows(rows, message.replacesDraftId)
    .map((row) => row.draftText!)
    .join('');
  return prefix && message.text.startsWith(prefix) ? { ...message, text: message.text.slice(prefix.length) } : message;
};

/**
 * Commit only an authoritative, settled prefix. Active, missing or uncertain
 * rows and their successors remain live so their ordering can still change.
 */
export function useNativeTranscript(state: TuiState, columns: number, epoch: number, header?: React.ReactNode) {
  const [stored, setStored] = useState<{ epoch: number; rows: readonly Row[] }>({ epoch, rows: [] });
  const rows = stored.epoch === epoch ? stored.rows : [];
  useEffect(() => {
    if (!state.timeline) return;
    const messages = new Map(state.messages.map((message) => [message.id, message]));
    const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
    // An active turn's assistant and tool rows stay live until it ends, so
    // their order can still change. Earlier user input is already settled.
    let reachedEnd = true;
    const next: Row[] = [];
    for (let i = 0; i < state.timeline.length; i++) {
      const entry = state.timeline[i]!;
      const key = `${entry.kind}:${entry.id}`;
      if (entry.kind === 'message') {
        const message = messages.get(entry.id);
        // The streaming draft owns the last timeline slot until its message arrives.
        if (!message && state.activeTurnId && entry.id in state.drafts && i === state.timeline.length - 1) break;
        if (
          !message ||
          (state.activeTurnId && message.role !== 'user' && (message.turnId === state.activeTurnId || !message.turnId))
        ) {
          reachedEnd = false;
          break;
        }
        next.push({ key, message });
        messages.delete(entry.id);
      } else {
        const tool = tools.get(entry.id);
        if (
          !tool ||
          tool.status === 'pending' ||
          tool.status === 'running' ||
          tool.outcomeUnknown ||
          (state.activeTurnId && tool.turnId === state.activeTurnId)
        ) {
          reachedEnd = false;
          break;
        }
        next.push({ key, tool });
        tools.delete(entry.id);
      }
    }
    // With no active turn, unordered fallback content cannot be committed.
    if (
      !state.activeTurnId &&
      (messages.size || tools.size || Object.keys(state.drafts).length || Object.keys(state.reasoning).length)
    )
      return;
    // Like the old CLI, move a streaming reply's settled markdown blocks into
    // scrollback so the live frame holds only the unfinished block. Only when
    // nothing live sits above the reply, or the order would change.
    const draftEntries = Object.entries(state.drafts);
    const canSplit =
      reachedEnd &&
      state.activeTurnId !== null &&
      messages.size === 0 &&
      tools.size === 0 &&
      draftEntries.length === 1 &&
      Object.keys(state.reasoning).length === 0;
    setStored((current) => {
      const previous = current.epoch === epoch ? current.rows : [];
      const expanded: Row[] = [];
      for (const row of next) {
        const replaced = row.message?.replacesDraftId;
        if (replaced) {
          expanded.push(...draftPrefixRows(previous, replaced));
          expanded.push({ ...row, message: withoutPrefix(row.message!, previous) });
        } else expanded.push(row);
      }
      if (canSplit) {
        const [id, text] = draftEntries[0]!;
        const existing = draftPrefixRows(previous, id);
        const done = prefixLength(previous, id);
        const offset = findMarkdownCommitOffset(text, done);
        expanded.push(...existing);
        if (offset > done)
          expanded.push({
            key: `draft:${id}:${existing.length}`,
            draftId: id,
            draftText: text.slice(done, offset),
            message: {
              id: `draft:${id}:${existing.length}`,
              role: 'assistant',
              text: text.slice(done, offset).trimEnd(),
            },
          });
      }
      if (previous.length > expanded.length || previous.some((row, i) => row.key !== expanded[i]?.key)) return current;
      return current.epoch === epoch && previous.length === expanded.length ? current : { epoch, rows: expanded };
    });
  }, [state, epoch]);

  const tail = useMemo(() => {
    const done = new Set(rows.map((row) => row.key));
    return {
      ...state,
      messages: state.messages
        .filter((message) => !done.has(`message:${message.id}`))
        .map((message) => withoutPrefix(message, rows)),
      drafts: Object.fromEntries(
        Object.entries(state.drafts).map(([id, text]) => {
          const prefix = prefixLength(rows, id);
          return [id, prefix ? text.slice(prefix) : text];
        }),
      ),
      tools: state.tools.filter((tool) => !done.has(`tool:${tool.id}`)),
      timeline: state.timeline?.filter((entry) => !done.has(`${entry.kind}:${entry.id}`)) ?? null,
    };
  }, [state, rows]);
  // Key the wrapper, not Static itself: Ink's old-node cleanup otherwise clears
  // the newly registered Static root during the same replacement commit.
  const failures = useMemo(() => failedShellGroups(rows.flatMap((row) => (row.tool ? [row.tool] : []))), [rows]);
  const staticTranscript = (
    <Box key={epoch}>
      <Static style={{ width: columns }} items={header ? [{ key: 'header', header }, ...rows] : [...rows]}>
        {(row) => {
          if (row.header) return <Box key={row.key}>{row.header}</Box>;
          const count = row.tool ? failures.get(row.tool.id) : undefined;
          if (count === 0) return <Box key={row.key} />;
          if (count !== undefined)
            return (
              <Box key={row.key} marginTop={1} paddingLeft={2}>
                <FailedShellSummary count={count} />
              </Box>
            );
          const entry = row.message
            ? { kind: 'message' as const, id: row.message.id }
            : { kind: 'tool' as const, id: row.tool!.id };
          const single = {
            ...state,
            messages: row.message ? [row.message] : [],
            tools: row.tool ? [row.tool] : [],
            timeline: [entry],
            drafts: {},
            reasoning: {},
          };
          const failed = row.tool && (row.tool.status === 'failed' || reportsFailure(row.tool.display));
          if (failed)
            return (
              <Box key={row.key} flexDirection="column">
                <Box flexDirection="column" maxHeight={10} overflowY="hidden">
                  <Transcript state={single} messages={single.messages} columns={columns} live staticRow />
                </Box>
                <Text dimColor>Full tool output: Ctrl+O</Text>
              </Box>
            );
          return (
            <Transcript key={row.key} state={single} messages={single.messages} columns={columns} live staticRow />
          );
        }}
      </Static>
    </Box>
  );
  return { staticTranscript, tail, committed: rows };
}
