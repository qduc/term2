import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, measureElement, renderToString, useStdout, Text, type DOMElement, type Key } from 'ink';
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

/**
 * Measure only the controls box height after React commits (never inside Ink's
 * synchronous `emitLayoutListeners` / `resetAfterCommit`, which can trigger
 * React nested-update #185 loops when layout shifts during commit).
 */
function useControlsHeight(
  ref: React.RefObject<DOMElement | null>,
  stdout: NodeJS.WriteStream,
): { readonly hasMeasured: boolean; readonly height: number } {
  const [measured, setMeasured] = useState<{ readonly hasMeasured: boolean; readonly height: number }>({
    hasMeasured: false,
    height: 0,
  });
  const measure = useCallback(() => {
    const node = ref.current;
    const next = node ? { hasMeasured: true, height: measureElement(node).height } : { hasMeasured: false, height: 0 };
    setMeasured((current) =>
      current.hasMeasured === next.hasMeasured && current.height === next.height ? current : next,
    );
  }, [ref]);

  useEffect(measure);
  useEffect(() => {
    stdout.on('resize', measure);
    return () => {
      stdout.off('resize', measure);
    };
  }, [stdout, measure]);
  return measured;
}

/** Render the skin and markdown at the terminal width, then scroll by visible rows. */
export function useTranscriptViewport(
  history: TuiState,
  columns: number,
  rows: number,
  helpRows: number,
  header?: React.ReactNode,
  historyRevision = 0,
  showReasoning = true,
) {
  const { stdout } = useStdout();
  // Ink accepts an unattached ref, though the metrics hook's type omits null.
  const controlsRef = useRef<DOMElement>(null!);
  const controls = useControlsHeight(controlsRef, stdout);
  // Stay below Ink's fullscreen threshold and leave a margin above the controls.
  const maxHeight = Math.max(1, rows - 1);
  const spaceAboveControls = controls.hasMeasured ? Math.max(0, maxHeight - controls.height) : 0;
  const availableRows = Math.max(0, spaceAboveControls - 1);
  const [epoch, setEpoch] = useState(0);
  const [reader, setReader] = useState<{ lines: readonly string[]; start: number } | null>(null);
  const state = useLegacyWindow(history, epoch);
  const redraw = () => {
    clearTerminalForRedraw(stdout);
    setReader(null);
    setEpoch((current) => current + 1);
  };
  const [frame, setFrame] = useState<{
    lines: string[];
    activeTurnId: string | null;
    columns: number;
    showReasoning: boolean;
    committed: readonly unknown[] | null;
  }>({
    lines: [],
    activeTurnId: null,
    columns,
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
      // The reading snapshot contains ANSI rows already wrapped at the old width.
      setReader(null);
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
  // Never print a throttled active-turn frame after its turn has settled.
  const lines =
    frame.columns !== columns ||
    frame.showReasoning !== showReasoning ||
    frame.committed !== committed ||
    (!state.activeTurnId && frame.activeTurnId)
      ? []
      : frame.lines;
  const renderLive = (shown: TuiState, ages: ReadonlyMap<string, LiveToolAge>): string[] => {
    const rendered = renderToString(
      <ThemeProvider theme={theme}>
        <SkinProvider skin={skin}>
          <LiveToolAgesContext.Provider value={ages}>
            <Transcript
              state={showReasoning ? shown : { ...shown, reasoning: {} }}
              messages={shown.messages}
              columns={columns}
              live
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
      const next = renderLive(state, new Map());
      clearTerminalForRedraw(stdout);
      setReader(null);
      setEpoch((current) => current + 1);
      setFrame({ lines: next, activeTurnId: state.activeTurnId, columns, showReasoning, committed: NO_ROWS });
    }, 0);
    return () => clearTimeout(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyRevision, stdout, showReasoning]);
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
      const shown = tail;
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
      const next = renderLive(shown, ages);
      for (const [id, text] of Object.entries(shown.drafts)) if (text) drawnDrafts.current.add(id);
      // A held reply drawn here counts as drawn: the next commit pass moves it to scrollback.
      for (const message of shown.messages)
        if (message.replacesDraftId) drawnDrafts.current.add(message.replacesDraftId);
      // An identical frame must not re-render the whole session.
      setFrame((previous) =>
        previous.columns === columns &&
        previous.showReasoning === showReasoning &&
        previous.committed === committed &&
        previous.activeTurnId === shown.activeTurnId &&
        previous.lines.length === next.length &&
        previous.lines.every((line, index) => line === next[index])
          ? previous
          : { lines: next, activeTurnId: shown.activeTurnId, columns, showReasoning, committed },
      );
    }, wait);
    return () => clearTimeout(pending);
  }, [tail, columns, theme, skin, showReasoning, committed, clock]);

  const clipped = lines.length > availableRows;
  const showHint =
    availableRows > 1 && (help ? helpLines.length > Math.min(helpRows, availableRows) : clipped || reader !== null);
  const height = availableRows - Number(showHint);
  const pageHeight = help ? Math.min(height, helpRows) : height;
  const source = help ? helpLines : reader?.lines ?? lines;
  const lastPage = Math.max(0, source.length - pageHeight);
  const start = help ? Math.min(helpOffset, lastPage) : reader ? Math.min(reader.start, lastPage) : lastPage;
  const end = Math.min(source.length, start + pageHeight);

  const handleKey = (key: Key): boolean => {
    if (key.escape && reader) {
      setReader(null);
      return true;
    }
    const up = key.pageUp || (key.ctrl && key.upArrow);
    const down = key.pageDown || (key.ctrl && key.downArrow);
    if ((!up && !down) || !pageHeight) return false;
    const delta = key.pageUp || key.pageDown ? pageHeight : 1;
    if (help) {
      setHelpOffset((current) => Math.max(0, Math.min(lastPage, current + (up ? -delta : delta))));
    } else if (up && (reader || clipped)) {
      // Keep the displayed rows even if new tokens arrive or the draft moves into Static.
      setReader((current) => ({
        lines: current?.lines ?? lines,
        start: Math.max(0, Math.min(current?.start ?? lastPage, lastPage) - delta),
      }));
    } else if (down && reader) {
      setReader((current) => {
        if (!current || current.start + delta >= lastPage) return null;
        return { ...current, start: current.start + delta };
      });
    }
    return true;
  };

  const text = source.slice(start, end).join('\n');
  const hasText = Boolean(text.trim());
  const hint = !showHint
    ? null
    : help
    ? `Lines ${start + 1}–${end} of ${source.length} · PgUp/PgDn or Ctrl+↑/↓`
    : reader
    ? `Lines ${start + 1}–${end} of ${source.length} · PgUp/PgDn · Esc to live`
    : 'PgUp to read earlier output';
  return {
    epoch,
    // The live text has been drawn for the current committed rows (false right after a remount, until its render).
    frameReady: frame.committed === committed && frame.showReasoning === showReasoning,
    staticTranscript,
    text: hasText ? text : null,
    hint,
    maxHeight,
    controlsBoxProps: {
      // An idle prompt with only Static history has no preview to lay out.
      ref: state.activeTurnId || reader || help || lines.length ? controlsRef : undefined,
      flexShrink: 0,
      flexDirection: 'column',
      paddingX: 2,
      // Legacy uses three rows of margin with no transcript. Yield it when the controls need the room.
      marginTop: controls.hasMeasured ? Math.min(hasText || hint ? 1 : 3, spaceAboveControls) : 3,
    } as const,
    setHelp,
    reading: reader !== null,
    closeReader: () => setReader(null),
    handleKey,
  };
}

type TranscriptFrameView = Pick<
  ReturnType<typeof useTranscriptViewport>,
  'staticTranscript' | 'text' | 'hint' | 'maxHeight' | 'reading'
>;

export function TranscriptFrame({ viewport, children }: React.PropsWithChildren<{ viewport: TranscriptFrameView }>) {
  const theme = useTheme();
  const { staticTranscript, text, hint, maxHeight, reading } = viewport;
  const visible = Boolean(text || hint);
  return (
    <Box flexDirection="column" maxHeight={visible ? maxHeight : undefined}>
      {staticTranscript}
      {visible ? (
        // Controls can grow in the same commit as a transcript update. Shrink and clip the
        // transcript in that layout while the measured row budget catches up.
        <Box
          flexDirection="column"
          flexShrink={1}
          overflowY="hidden"
          justifyContent={reading ? 'flex-start' : 'flex-end'}
        >
          <Box flexDirection="column" flexShrink={0}>
            {text ? <Text>{text}</Text> : null}
            {hint ? (
              <Text color={theme.textSubtle} wrap="truncate-end">
                {hint}
              </Text>
            ) : null}
          </Box>
        </Box>
      ) : null}
      {children}
    </Box>
  );
}
