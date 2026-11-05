import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static } from 'ink';
import type { Message, ToolView, TuiState } from './state.js';
import { Transcript } from './views.js';
import { groupTools, ToolGroupRow } from './tool-groups.js';
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
/** The committed rows of a freshly mounted list; one shared value so a frame drawn for it stays current. */
export const NO_ROWS: readonly Row[] = [];

export function useNativeTranscript(
  state: TuiState,
  columns: number,
  epoch: number,
  header?: React.ReactNode,
  /** The live frame: the drafts it has drawn (a reply whose draft was never drawn was never live) and its latest
   * drawing, after which held rows commit. */
  drawn?: { readonly drafts: { readonly current: ReadonlySet<string> }; readonly frame: unknown },
) {
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
        // Legacy keeps a trailing run of consecutive tool calls live until a later message closes it, even
        // after the turn ends (findOpenTrailingCommandRunStart), so Static never freezes a partial group.
        const openRun = tool && state.timeline.slice(i + 1).every((later) => later.kind === 'tool');
        if (!tool || tool.status === 'pending' || tool.status === 'running' || tool.outcomeUnknown || openRun) {
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
  // A first mount with settled history and nothing live commits it all at once (the effect below would, one render
  // later). Legacy's first frame already holds its Static history, so a resumed session paints with its composer.
  const [stored, setStored] = useState<{ epoch: number; rows: readonly Row[] }>(() => ({
    epoch,
    rows:
      settled?.next.length &&
      !state.activeTurnId &&
      !settled.orphans &&
      !Object.keys(state.drafts).length &&
      !Object.keys(state.reasoning).length
        ? settled.next
        : NO_ROWS,
  }));
  const rows = stored.epoch === epoch ? stored.rows : NO_ROWS;
  // Legacy MessageList (shouldCommitMessageToStatic): with nothing live below, a finished row that was never live (a
  // system line, or every row after a redraw remounts the list) stays in the live region for one render, and is
  // committed on the next one. Resumed history and rows that were live (a reply replacing its draft) commit at once.
  const commit = useRef<{
    epoch: number;
    signature: string | null;
    seen: ReadonlySet<string> | null;
    candidates: ReadonlySet<string>;
  }>({ epoch, signature: null, seen: null, candidates: new Set() });
  useEffect(() => {
    if (!settled) return;
    const { next, reachedEnd, orphans } = settled;
    const memory = commit.current;
    const remounted = memory.epoch !== epoch;
    // Legacy's list renders again only when its messages change; this effect also runs for unrelated updates.
    const signature = [
      state.activeTurnId ?? '',
      ...(state.timeline ?? []).map((entry) => `${entry.kind}:${entry.id}`),
      ...state.tools.map((tool) => tool.status),
    ].join('\u0000');
    const rendered = remounted || signature !== memory.signature;
    const deferred = new Set<string>(rendered ? [] : memory.candidates);
    // A remount starts legacy's list afresh: every row waits for its next render, whatever waited before.
    // Legacy's hasActiveMessages: anything still streaming or running below the settled rows.
    const live =
      !reachedEnd || orphans > 0 || Object.keys(state.drafts).length > 0 || Object.keys(state.reasoning).length > 0;
    const fresh = (row: Row) =>
      !live &&
      (!row.message?.replacesDraftId ||
        (drawn !== undefined && !drawn.drafts.current.has(row.message.replacesDraftId))) &&
      (remounted || (memory.candidates.has(row.key) ? !rendered : memory.seen !== null && !memory.seen.has(row.key)));
    commit.current = {
      epoch,
      signature,
      seen: new Set(state.timeline?.map((entry) => `${entry.kind}:${entry.id}`) ?? []),
      candidates: deferred,
    };
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
      const held = expanded.findIndex((row, i) => i >= previous.length && fresh(row));
      if (held >= 0) {
        for (const row of expanded.slice(held)) deferred.add(row.key);
        expanded.length = held;
      }
      if (current.epoch === epoch && previous.length === expanded.length) return current;
      return { epoch, rows: expanded.length ? expanded : NO_ROWS };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, state.drafts, state.reasoning, state.activeTurnId, epoch, drawn?.frame]);

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
  const groups = useMemo(
    () =>
      groupTools(
        rows.map((row) =>
          row.message ? { kind: 'message' as const, id: row.message.id } : { kind: 'tool' as const, id: row.tool!.id },
        ),
        rows.flatMap((row) => (row.tool ? [row.tool] : [])),
        true,
        state.toolShownAt,
      ),
    [rows, state.toolShownAt],
  );
  // A fresh style object makes Ink mark <Static> dirty on every commit, which bypasses its render throttle.
  const staticStyle = useMemo(() => ({ width: columns }), [columns]);
  // Memoise the element: any Static re-render hands Ink a fresh children array, which marks it dirty
  // and forces an unthrottled repaint. Rows render once, so the closure only needs state as of the row change.
  const staticTranscript = useMemo(
    () => (
      <Box key={epoch}>
        <Static style={staticStyle} items={header ? [{ key: 'header', header }, ...rows] : [...rows]}>
          {(row) => {
            if (row.header) return <Box key={row.key}>{row.header}</Box>;
            const group = row.tool ? groups.get(row.tool.id) : undefined;
            if (group === null) return <Box key={row.key} />;
            if (group !== undefined)
              return (
                <Box key={row.key} marginTop={1} paddingLeft={2} width={columns - 2}>
                  <ToolGroupRow group={group} />
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
            return (
              <Box key={row.key}>
                <Transcript state={single} messages={single.messages} columns={columns} live staticRow />
              </Box>
            );
          }}
        </Static>
      </Box>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [epoch, header, rows, groups, columns, staticStyle],
  );
  return { staticTranscript, tail, committed: rows };
}
