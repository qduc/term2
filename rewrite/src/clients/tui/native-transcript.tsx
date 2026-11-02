import React, { useEffect, useMemo, useState } from 'react';
import { Box, Static, Text } from 'ink';
import { reportsFailure } from './tool-view.js';
import type { Message, ToolView, TuiState } from './state.js';
import { Transcript } from './views.js';

type Row = {
  readonly key: string;
  readonly message?: Message;
  readonly tool?: ToolView;
  readonly header?: React.ReactNode;
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
    // A user input can lack a turn ID. Keep the latest one live during a turn,
    // and stop earlier at any active or unowned non-user row.
    let boundary = state.timeline.length;
    if (state.activeTurnId) {
      let latestUser = -1;
      for (let i = state.timeline.length - 1; i >= 0; i--) {
        const entry = state.timeline[i]!;
        if (entry.kind === 'message' && messages.get(entry.id)?.role === 'user') {
          latestUser = i;
          break;
        }
      }
      if (latestUser < 0) return;
      boundary = latestUser;
    }
    const next: Row[] = [];
    for (let i = 0; i < boundary; i++) {
      const entry = state.timeline[i]!;
      const key = `${entry.kind}:${entry.id}`;
      if (entry.kind === 'message') {
        const message = messages.get(entry.id);
        if (
          !message ||
          (state.activeTurnId &&
            (message.turnId === state.activeTurnId || (!message.turnId && message.role !== 'user')))
        )
          break;
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
        )
          break;
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
    setStored((current) => {
      const previous = current.epoch === epoch ? current.rows : [];
      if (previous.length > next.length || previous.some((row, i) => row.key !== next[i]?.key)) return current;
      return current.epoch === epoch && previous.length === next.length ? current : { epoch, rows: next };
    });
  }, [state, epoch]);

  const tail = useMemo(() => {
    const done = new Set(rows.map((row) => row.key));
    return {
      ...state,
      messages: state.messages.filter((message) => !done.has(`message:${message.id}`)),
      tools: state.tools.filter((tool) => !done.has(`tool:${tool.id}`)),
      timeline: state.timeline?.filter((entry) => !done.has(`${entry.kind}:${entry.id}`)) ?? null,
    };
  }, [state, rows]);
  // Key the wrapper, not Static itself: Ink's old-node cleanup otherwise clears
  // the newly registered Static root during the same replacement commit.
  const staticTranscript = (
    <Box key={epoch}>
      <Static items={header ? [{ key: 'header', header }, ...rows] : [...rows]}>
        {(row) => {
          if (row.header) return <Box key={row.key}>{row.header}</Box>;
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
                  <Transcript state={single} messages={single.messages} columns={columns} live />
                </Box>
                <Text dimColor>Full tool output: Ctrl+O</Text>
              </Box>
            );
          return <Transcript key={row.key} state={single} messages={single.messages} columns={columns} live />;
        }}
      </Static>
    </Box>
  );
  return { staticTranscript, tail, committed: rows };
}
