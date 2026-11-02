import React, { useEffect, useRef, useState } from 'react';
import { renderToString, useInput, Text } from 'ink';
import { ThemeProvider, useTheme } from '../../../../source/components/theme.js';
import { SkinProvider, useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiState } from './state.js';
import { Transcript } from './views.js';

/** Minimum spacing between transcript renders (about 8 frames a second). */
const RENDER_INTERVAL_MS = 120;

/** Render the skin and markdown at the terminal width, then scroll by visible rows. */
export function useTranscriptViewport(state: TuiState, columns: number, rows: number, active: boolean) {
  // A `/help` text takes over the viewport (scrollable) until the next command clears it.
  const [help, setHelp] = useState<string | null>(null);
  const theme = useTheme();
  const skin = useSkin();
  const [lines, setLines] = useState<string[]>([]);
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
  const [expanded, setExpanded] = useState(false);
  const height = Math.max(1, rows - 9);
  const lastRender = useRef(0);
  useEffect(() => {
    // Streaming changes the state many times a second. Rendering the whole transcript for each change burned
    // 60-85% of a core, so renders are spaced RENDER_INTERVAL_MS apart; the last state always gets its render.
    const wait = Math.max(0, lastRender.current + RENDER_INTERVAL_MS - performance.now());
    // Ink shares its reconciler with the live root. renderToString must finish
    // outside React's effect/commit stack or it can free a still-pending Yoga root.
    const pending = setTimeout(() => {
      lastRender.current = performance.now();
      const rendered = renderToString(
        <ThemeProvider theme={theme}>
          <SkinProvider skin={skin}>
            <Transcript state={state} messages={state.messages} columns={columns} live expanded={expanded} />
          </SkinProvider>
        </ThemeProvider>,
        { columns: Math.max(1, columns) },
      );
      const next = rendered ? rendered.split('\n') : [];
      // An identical frame must not re-render the whole session.
      setLines((previous) =>
        previous.length === next.length && previous.every((line, index) => line === next[index]) ? previous : next,
      );
    }, wait);
    return () => clearTimeout(pending);
  }, [state, columns, theme, skin, expanded]);
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
      } else if (key.ctrl && input === 'o') setExpanded((current) => !current);
      else if (key.pageUp || (key.ctrl && key.upArrow)) {
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
      text: helpLines.slice(start, end).join('\n'),
      start,
      end,
      total: helpLines.length,
      live: end === helpLines.length,
      setHelp,
    };
  }
  const end = Math.max(0, lines.length - visibleOffset);
  const start = Math.max(0, end - height);
  return {
    text: lines.slice(start, end).join('\n'),
    start,
    end,
    total: lines.length,
    live: visibleOffset === 0,
    setHelp,
  };
}
