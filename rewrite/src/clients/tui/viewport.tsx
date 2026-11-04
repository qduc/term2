import React, { useEffect, useRef, useState } from 'react';
import { renderToString, useInput, useStdout, Text } from 'ink';
import { ThemeProvider, useTheme } from './presentation/components/theme.js';
import { SkinProvider, useSkin } from './presentation/skins/SkinContext.js';
import type { TuiState } from './state.js';
import { Transcript } from './views.js';
import { useNativeTranscript } from './native-transcript.js';
import { clearTerminalForRedraw, clearVisibleForResize } from './terminal.js';

/** Minimum spacing between transcript renders (about 8 frames a second). */
const RENDER_INTERVAL_MS = 120;

/** Render the skin and markdown at the terminal width, then scroll by visible rows. */
export function useTranscriptViewport(
  state: TuiState,
  columns: number,
  rows: number,
  active: boolean,
  header?: React.ReactNode,
  historyRevision = 0,
) {
  const { stdout } = useStdout();
  const [epoch, setEpoch] = useState(0);
  const redraw = () => {
    clearTerminalForRedraw(stdout);
    setEpoch((current) => current + 1);
  };
  const { staticTranscript, tail, committed } = useNativeTranscript(state, columns, epoch, header);
  const previousHistoryRevision = useRef(historyRevision);
  useEffect(() => {
    if (previousHistoryRevision.current === historyRevision) return;
    previousHistoryRevision.current = historyRevision;
    clearTerminalForRedraw(stdout);
    setEpoch((current) => current + 1);
  }, [historyRevision, stdout]);
  const activeTurn = useRef(state.activeTurnId);
  activeTurn.current = state.activeTurnId;
  const pendingResize = useRef(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (activeTurn.current) {
          pendingResize.current = true;
          return;
        }
        clearVisibleForResize(stdout);
        setEpoch((current) => current + 1);
      }, 300);
    };
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
      if (timer) clearTimeout(timer);
    };
  }, [stdout]);
  useEffect(() => {
    if (state.activeTurnId || !pendingResize.current) return;
    pendingResize.current = false;
    clearVisibleForResize(stdout);
    setEpoch((current) => current + 1);
  }, [state.activeTurnId, stdout]);
  // A `/help` text takes over the viewport (scrollable) until the next command clears it.
  const [help, setHelp] = useState<string | null>(null);
  const theme = useTheme();
  const skin = useSkin();
  const [expanded, setExpanded] = useState(false);
  const [frame, setFrame] = useState<{
    lines: string[];
    activeTurnId: string | null;
    expanded: boolean;
    committed: readonly unknown[] | null;
  }>({
    lines: [],
    activeTurnId: null,
    expanded: false,
    committed: null,
  });
  // Never print a throttled active-turn frame after its turn has settled.
  const lines =
    frame.expanded !== expanded ||
    (!expanded && frame.committed !== committed) ||
    (!state.activeTurnId && frame.activeTurnId)
      ? []
      : frame.lines;
  const [offset, setOffset] = useState(0);
  const [helpOffset, setHelpOffset] = useState(0);
  const [helpLines, setHelpLines] = useState<string[]>([]);
  useEffect(() => {
    setHelpOffset(0);
    if (!help) return;
    const pending = setTimeout(() => {
      setHelpLines(renderToString(<Text>{help}</Text>, { columns: Math.max(1, columns) }).split('\n'));
    }, 0);
    return () => clearTimeout(pending);
  }, [help, columns]);
  // Ctrl+O shows every tool's output; by default only failures and edits are open.
  const height = Math.max(1, rows - 9);
  const lastRender = useRef(0);
  const [clock, setClock] = useState(0);
  const activeShell = state.tasks.some((task) => task.wire?.kind === 'shell' && task.status === 'running');
  useEffect(() => {
    if (!activeShell) return;
    const timer = setInterval(() => setClock((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [activeShell]);
  useEffect(() => {
    // Streaming changes the state many times a second. Rendering the whole transcript for each change burned
    // 60-85% of a core, so renders are spaced RENDER_INTERVAL_MS apart; the last state always gets its render.
    const wait = Math.max(0, lastRender.current + RENDER_INTERVAL_MS - performance.now());
    // Ink shares its reconciler with the live root. renderToString must finish
    // outside React's effect/commit stack or it can free a still-pending Yoga root.
    const pending = setTimeout(() => {
      lastRender.current = performance.now();
      const shown = expanded ? state : tail;
      const rendered = renderToString(
        <ThemeProvider theme={theme}>
          <SkinProvider skin={skin}>
            <Transcript state={shown} messages={shown.messages} columns={columns} live expanded={expanded} />
          </SkinProvider>
        </ThemeProvider>,
        { columns: Math.max(1, columns) },
      );
      const next = rendered ? rendered.split('\n') : [];
      // An identical frame must not re-render the whole session.
      setFrame((previous) =>
        previous.expanded === expanded &&
        previous.committed === committed &&
        previous.activeTurnId === shown.activeTurnId &&
        previous.lines.length === next.length &&
        previous.lines.every((line, index) => line === next[index])
          ? previous
          : { lines: next, activeTurnId: shown.activeTurnId, expanded, committed },
      );
    }, wait);
    return () => clearTimeout(pending);
  }, [state, tail, columns, theme, skin, expanded, committed, clock]);
  const maxOffset = Math.max(0, lines.length - height);
  const visibleOffset = Math.min(offset, maxOffset);
  useInput(
    (input, key) => {
      if (help && (key.pageUp || key.pageDown || (key.ctrl && (key.upArrow || key.downArrow)))) {
        const delta = key.pageUp || key.pageDown ? height : 1;
        setHelpOffset((current) =>
          Math.max(
            0,
            Math.min(Math.max(0, helpLines.length - height), current + (key.pageUp || key.upArrow ? -delta : delta)),
          ),
        );
      } else if (key.pageUp || (key.ctrl && key.upArrow)) {
        setOffset((current) => Math.min(maxOffset, current + (key.pageUp ? height : 1)));
      } else if (key.pageDown || (key.ctrl && key.downArrow)) {
        setOffset((current) => Math.max(0, current - (key.pageDown ? height : 1)));
      }
    },
    { isActive: active },
  );
  if (help) {
    const start = Math.min(helpOffset, Math.max(0, helpLines.length - height));
    const end = Math.min(helpLines.length, start + height);
    return {
      staticTranscript,
      redraw,
      paged: true,
      text: helpLines.slice(start, end).join('\n'),
      start,
      end,
      total: helpLines.length,
      live: end === helpLines.length,
      setHelp,
      expanded,
      collapse: () => {
        setOffset(0);
        setExpanded(false);
      },
    };
  }
  const end = Math.max(0, lines.length - visibleOffset);
  const start = !expanded && visibleOffset === 0 ? 0 : Math.max(0, end - height);
  return {
    staticTranscript,
    redraw,
    paged: expanded,
    text: lines.slice(start, end).join('\n'),
    start,
    end,
    total: lines.length,
    live: visibleOffset === 0,
    setHelp,
    expanded,
    collapse: () => {
      setOffset(0);
      setExpanded(false);
    },
  };
}
