import React, { useEffect, useState } from 'react';
import { renderToString, useInput } from 'ink';
import { ThemeProvider, useTheme } from '../../../../source/components/theme.js';
import { SkinProvider, useSkin } from '../../../../source/skins/SkinContext.js';
import type { TuiState } from './state.js';
import { Transcript } from './views.js';

/** Render the skin and markdown at the terminal width, then scroll by visible rows. */
export function useTranscriptViewport(state: TuiState, columns: number, rows: number, active: boolean) {
  const theme = useTheme();
  const skin = useSkin();
  const [lines, setLines] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const height = Math.max(1, rows - 9);
  useEffect(() => {
    const rendered = renderToString(
      <ThemeProvider theme={theme}><SkinProvider skin={skin}>
        <Transcript state={state} messages={state.messages} columns={columns} live />
      </SkinProvider></ThemeProvider>, { columns: Math.max(1, columns) },
    );
    setLines(rendered ? rendered.split('\n') : []);
  }, [state, columns, theme, skin]);
  const maxOffset = Math.max(0, lines.length - height);
  const visibleOffset = Math.min(offset, maxOffset);
  useInput((_input, key) => {
    if (key.pageUp || (key.ctrl && key.upArrow)) {
      setOffset(current => Math.min(maxOffset, current + (key.pageUp ? height : 1)));
    } else if (key.pageDown || (key.ctrl && key.downArrow)) {
      setOffset(current => Math.max(0, current - (key.pageDown ? height : 1)));
    }
  }, { isActive: active });
  const end = Math.max(0, lines.length - visibleOffset);
  const start = Math.max(0, end - height);
  return { text: lines.slice(start, end).join('\n'), start, end, total: lines.length, live: visibleOffset === 0 };
}
