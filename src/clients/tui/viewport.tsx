import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderToString, useInput, useStdout, Text } from 'ink';
import { ThemeProvider, useTheme } from './presentation/components/theme.js';
import { SkinProvider, useSkin } from './presentation/skins/SkinContext.js';
import type { TuiState } from './state.js';
import { Transcript } from './views.js';
import { LiveToolAgesContext, type LiveToolAge } from './live-tool-age.js';
import { NO_ROWS, useNativeTranscript } from './native-transcript.js';
import { clearTerminalForRedraw, clearVisibleForResize } from './terminal.js';

/** Minimum spacing between transcript renders (about 8 frames a second). */
const RENDER_INTERVAL_MS = 120;

/** Legacy keeps its last 300 UI messages (use-conversation MAX_MESSAGE_COUNT): a mount or a remount prints only those. */
const LEGACY_MESSAGE_CAP = 300;
const entryKey = (entry: { readonly kind: string; readonly id: string }) => `${entry.kind}:${entry.id}`;

/**
 * The history a mount shows: the last LEGACY_MESSAGE_CAP timeline entries. Its first entry is fixed for the epoch
 * once there is history, so rows keep committing below it as the session grows, like legacy's append-only Static.
 */
function useLegacyWindow(state: TuiState, epoch: number): TuiState {
  const start = useRef<{ epoch: number; key: string }>({ epoch: -1, key: '' });
  const timeline = state.timeline;
  if (start.current.epoch !== epoch && timeline?.length)
    start.current = { epoch, key: entryKey(timeline[Math.max(0, timeline.length - LEGACY_MESSAGE_CAP)]!) };
  const key = start.current.epoch === epoch ? start.current.key : '';
  const windowed = useMemo(() => {
    const index = key && timeline ? timeline.findIndex((entry) => entryKey(entry) === key) : -1;
    if (!timeline || index <= 0) return null;
    const dropped = new Set(timeline.slice(0, index).map(entryKey));
    const tools = state.tools.filter((tool) => {
      if (!dropped.has(`tool:${tool.id}`) && !(tool.parent && dropped.has(`tool:${tool.parent}`))) return true;
      dropped.add(`tool:${tool.id}`);
      return false;
    });
    const messages = state.messages.filter((message) => !dropped.has(`message:${message.id}`));
    return { timeline: timeline.slice(index), messages, tools };
  }, [timeline, state.messages, state.tools, key]);
  return useMemo(() => (windowed ? { ...state, ...windowed } : state), [state, windowed]);
}

/** Render the skin and markdown at the terminal width, then scroll by visible rows. */
export function useTranscriptViewport(
  history: TuiState,
  columns: number,
  rows: number,
  active: boolean,
  header?: React.ReactNode,
  historyRevision = 0,
  showReasoning = true,
) {
  const { stdout } = useStdout();
  const [epoch, setEpoch] = useState(0);
  const state = useLegacyWindow(history, epoch);
  const redraw = () => {
    clearTerminalForRedraw(stdout);
    setEpoch((current) => current + 1);
  };
  const [frame, setFrame] = useState<{
    lines: string[];
    activeTurnId: string | null;
    expanded: boolean;
    showReasoning: boolean;
    committed: readonly unknown[] | null;
  }>({
    lines: [],
    activeTurnId: null,
    expanded: false,
    showReasoning,
    committed: null,
  });
  // Legacy draws a streamed reply live before it commits; a reply the throttled frame never drew is held for one
  // frame. Each drawn frame is the "next render" that commits held rows.
  const drawnDrafts = useRef(new Set<string>());
  const { staticTranscript, tail, committed } = useNativeTranscript(state, columns, epoch, header, {
    drafts: drawnDrafts,
    frame,
  });
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
  // Never print a throttled active-turn frame after its turn has settled.
  const lines =
    frame.expanded !== expanded ||
    frame.showReasoning !== showReasoning ||
    (!expanded && frame.committed !== committed) ||
    (!state.activeTurnId && frame.activeTurnId)
      ? []
      : frame.lines;
  const renderLive = (shown: TuiState, ages: ReadonlyMap<string, LiveToolAge>, all: boolean): string[] => {
    const rendered = renderToString(
      <ThemeProvider theme={theme}>
        <SkinProvider skin={skin}>
          <LiveToolAgesContext.Provider value={ages}>
            <Transcript
              state={showReasoning ? shown : { ...shown, reasoning: {} }}
              messages={shown.messages}
              columns={columns}
              live
              expanded={all}
            />
          </LiveToolAgesContext.Provider>
        </SkinProvider>
      </ThemeProvider>,
      { columns: Math.max(1, columns) },
    );
    return rendered ? rendered.split('\n') : [];
  };
  // A history replacement (rewind) remounts the list with every row live. Legacy draws those rows in the same
  // frame as its remounted input, so the live frame is rendered first and lands with the new epoch.
  const previousHistoryRevision = useRef(historyRevision);
  useEffect(() => {
    if (previousHistoryRevision.current === historyRevision) return;
    previousHistoryRevision.current = historyRevision;
    // A replacement that starts a turn (retry) remounts at once: legacy remounts before the new reply streams, so the
    // remounted rows commit when that reply renders. Deferring it could land the remount after the turn had ended,
    // leaving every row live.
    if (state.activeTurnId) return redraw();
    const pending = setTimeout(() => {
      const next = renderLive(state, new Map(), false);
      clearTerminalForRedraw(stdout);
      setEpoch((current) => current + 1);
      setFrame({ lines: next, activeTurnId: state.activeTurnId, expanded: false, showReasoning, committed: NO_ROWS });
    }, 0);
    return () => clearTimeout(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRevision, stdout, showReasoning]);
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
  const inFlight = state.tools.some((tool) => tool.status === 'pending' || tool.status === 'running');
  // Live rows are drawn by a one-shot render, so their one-second delay and elapsed counter come from here.
  const firstSeen = useRef(new Map<string, { inFlight: number; running?: number }>());
  useEffect(() => {
    if (!activeShell && !inFlight) return;
    const timer = setInterval(() => setClock((value) => value + 1), inFlight ? 250 : 1000);
    return () => clearInterval(timer);
  }, [activeShell, inFlight]);
  useEffect(() => {
    // Streaming changes the state many times a second. Rendering the whole transcript for each change burned
    // 60-85% of a core, so renders are spaced RENDER_INTERVAL_MS apart; the last state always gets its render.
    const wait = Math.max(0, lastRender.current + RENDER_INTERVAL_MS - performance.now());
    // Ink shares its reconciler with the live root. renderToString must finish
    // outside React's effect/commit stack or it can free a still-pending Yoga root.
    const pending = setTimeout(() => {
      lastRender.current = performance.now();
      const shown = expanded ? state : tail;
      const now = performance.now();
      const ages = new Map<string, LiveToolAge>();
      const seen = new Map<string, { inFlight: number; running?: number }>();
      for (const tool of shown.tools) {
        if (tool.status !== 'pending' && tool.status !== 'running') continue;
        const before = firstSeen.current.get(tool.id);
        const entry = {
          inFlight: before?.inFlight ?? now,
          ...(tool.status === 'running' ? { running: before?.running ?? now } : {}),
        };
        seen.set(tool.id, entry);
        ages.set(tool.id, {
          inFlightMs: now - entry.inFlight,
          ...(entry.running === undefined ? {} : { runningMs: now - entry.running }),
        });
      }
      firstSeen.current = seen;
      const next = renderLive(shown, ages, expanded);
      for (const [id, text] of Object.entries(shown.drafts)) if (text) drawnDrafts.current.add(id);
      // A held reply drawn here counts as drawn: the next commit pass moves it to scrollback.
      for (const message of shown.messages)
        if (message.replacesDraftId) drawnDrafts.current.add(message.replacesDraftId);
      // An identical frame must not re-render the whole session.
      setFrame((previous) =>
        previous.expanded === expanded &&
        previous.showReasoning === showReasoning &&
        previous.committed === committed &&
        previous.activeTurnId === shown.activeTurnId &&
        previous.lines.length === next.length &&
        previous.lines.every((line, index) => line === next[index])
          ? previous
          : { lines: next, activeTurnId: shown.activeTurnId, expanded, showReasoning, committed },
      );
    }, wait);
    return () => clearTimeout(pending);
  }, [state, tail, columns, theme, skin, expanded, showReasoning, committed, clock]);
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
      epoch,
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
    epoch,
    staticTranscript,
    redraw,
    paged: expanded,
    // The live text has been drawn for the current committed rows (false right after a remount, until its render).
    frameReady: frame.committed === committed && frame.showReasoning === showReasoning,
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
