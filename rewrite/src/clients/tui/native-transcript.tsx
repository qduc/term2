import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text } from 'ink';
import { isUnknownCreateFile, reportsFailure } from './tool-view.js';
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
  /** The reply's last row keeps the blank row its live form had, so the footer rests where it did. */
  readonly trailingBlank?: true;
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
  // Per-token state changes only touch drafts; the settled-row scan walks the whole
  // history, so it is keyed on the history itself and the draft ids.
  const draftIds = Object.keys(state.drafts).join('\u0000');
  const settled = useMemo(() => {
    if (!state.timeline) return null;
    const draftKeys = new Set(draftIds ? draftIds.split('\u0000') : []);
    const messages = new Map(state.messages.map((message) => [message.id, message]));
    const tools = new Map(state.tools.map((tool) => [tool.id, tool]));
    // Keep active rows live until a completed tool closes its assistant lead-in.
    // A queued user row after that tool remains live during the turn.
    let reachedEnd = true;
    const next: Row[] = [];
    for (let i = 0; i < state.timeline.length; i++) {
      const entry = state.timeline[i]!;
      const key = `${entry.kind}:${entry.id}`;
      if (entry.kind === 'message') {
        const message = messages.get(entry.id);
        const following = state.timeline[i + 1];
        const followingTool = following?.kind === 'tool' ? tools.get(following.id) : undefined;
        const completedLeadIn =
          followingTool?.turnId === state.activeTurnId &&
          followingTool.status !== 'pending' &&
          followingTool.status !== 'running' &&
          !followingTool.outcomeUnknown;
        const preceding = state.timeline[i - 1];
        const precedingTool =
          preceding?.kind === 'tool' ? state.tools.find((tool) => tool.id === preceding.id) : undefined;
        if (state.activeTurnId && message?.role === 'user' && precedingTool?.turnId === state.activeTurnId) {
          reachedEnd = false;
          break;
        }
        // The streaming draft owns the last timeline slot until its message arrives.
        if (!message && state.activeTurnId && draftKeys.has(entry.id) && i === state.timeline.length - 1) break;
        if (
          !message ||
          (state.activeTurnId &&
            message.role !== 'user' &&
            (message.turnId === state.activeTurnId || !message.turnId) &&
            !completedLeadIn)
        ) {
          reachedEnd = false;
          break;
        }
        next.push({ key, message });
        messages.delete(entry.id);
      } else {
        const tool = tools.get(entry.id);
        // Failed shells can be grouped with later failures in the same turn.
        // Keep them live until the turn settles so Static never freezes a partial group.
        const openFailureGroup =
          tool &&
          state.activeTurnId &&
          tool.turnId === state.activeTurnId &&
          tool.name === 'shell' &&
          (tool.status === 'failed' || (tool.status === 'completed' && reportsFailure(tool.display)));
        if (
          !tool ||
          tool.status === 'pending' ||
          tool.status === 'running' ||
          tool.outcomeUnknown ||
          openFailureGroup
        ) {
          reachedEnd = false;
          break;
        }
        next.push({ key, tool });
        tools.delete(entry.id);
      }
    }
    return { next, reachedEnd, orphans: messages.size + tools.size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.timeline, state.messages, state.tools, state.activeTurnId, draftIds]);
  useEffect(() => {
    if (!settled) return;
    const { next, reachedEnd, orphans } = settled;
    // With no active turn, unordered fallback content cannot be committed.
    if (!state.activeTurnId && (orphans || Object.keys(state.drafts).length || Object.keys(state.reasoning).length))
      return;
    // Like the old CLI, move a streaming reply's settled markdown blocks into
    // scrollback so the live frame holds only the unfinished block. Only when
    // nothing live sits above the reply, or the order would change.
    const draftEntries = Object.entries(state.drafts);
    const canSplit =
      reachedEnd &&
      state.activeTurnId !== null &&
      orphans === 0 &&
      draftEntries.length === 1 &&
      Object.keys(state.reasoning).length === 0;
    setStored((current) => {
      const previous = current.epoch === epoch ? current.rows : [];
      const expanded: Row[] = [];
      for (const row of next) {
        const replaced = row.message?.replacesDraftId;
        if (replaced) {
          expanded.push(...draftPrefixRows(previous, replaced));
          const prefixed = draftPrefixRows(previous, replaced).length > 0;
          expanded.push({
            ...row,
            message: withoutPrefix(row.message!, previous),
            ...(prefixed ? { trailingBlank: true as const } : {}),
          });
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
  }, [settled, state.drafts, state.reasoning, state.activeTurnId, epoch]);

  // The unsettled remainder changes only when history or the committed rows do.
  const remainder = useMemo(() => {
    const done = new Set(rows.map((row) => row.key));
    return {
      messages: state.messages
        .filter((message) => !done.has(`message:${message.id}`))
        .map((message) => withoutPrefix(message, rows)),
      tools: state.tools.filter((tool) => !done.has(`tool:${tool.id}`)),
      timeline: state.timeline?.filter((entry) => !done.has(`${entry.kind}:${entry.id}`)) ?? null,
    };
  }, [state.messages, state.tools, state.timeline, rows]);
  const tail = useMemo(
    () => ({
      ...state,
      ...remainder,
      drafts: Object.fromEntries(
        Object.entries(state.drafts).map(([id, text]) => {
          const prefix = prefixLength(rows, id);
          return [id, prefix ? text.slice(prefix) : text];
        }),
      ),
    }),
    [state, remainder, rows],
  );
  // Key the wrapper, not Static itself: Ink's old-node cleanup otherwise clears
  // the newly registered Static root during the same replacement commit.
  const failures = useMemo(() => failedShellGroups(rows.flatMap((row) => (row.tool ? [row.tool] : []))), [rows]);
  // A fresh style object makes Ink mark <Static> dirty on every commit, which bypasses its render throttle.
  const staticStyle = useMemo(() => ({ width: columns }), [columns]);
  // Memoise the element: any Static re-render hands Ink a fresh children array, which marks it dirty
  // and forces an unthrottled repaint. Rows render once, so the closure only needs state as of the row change.
  const staticTranscript = useMemo(
    () => (
      <Box key={epoch}>
        <Static style={staticStyle} items={header ? [{ key: 'header', header }, ...rows] : [...rows]}>
          {(row, index) => {
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
            const failed =
              row.tool &&
              !isUnknownCreateFile(row.tool) &&
              (row.tool.status === 'failed' || reportsFailure(row.tool.display));
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
              <Box
                key={row.key}
                paddingBottom={row.trailingBlank ? 1 : 0}
                marginTop={row.message?.role === 'user' && index > (header ? 1 : 0) ? 1 : 0}
              >
                <Transcript state={single} messages={single.messages} columns={columns} live staticRow />
              </Box>
            );
          }}
        </Static>
      </Box>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [epoch, header, rows, failures, columns, staticStyle],
  );
  return { staticTranscript, tail, committed: rows };
}
