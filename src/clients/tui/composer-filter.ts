import { isShiftTab } from './shift-tab.js';
import { useEffect, useRef } from 'react';
import { useStdin, type Key } from 'ink';

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

type FilterOptions = {
  readonly composerActive: boolean;
  readonly outputExpanded: boolean;
  /** The draft before this chunk, and how to empty it: the sent text is never inserted, so the draft would stay. */
  readonly draft: {
    readonly value: string;
    readonly cursor: { readonly current: number };
    readonly replace: (text: string, cursor?: number) => void;
  };
  /** Send the whole draft as if Enter had been pressed after typing it. */
  readonly submit: (text: string) => void;
};

/**
 * Which keys the composer's editor must not see. Also repairs coalesced input: while a turn streams, a
 * sender's text and its Enter can reach the terminal in one chunk (`text\r`). The editor takes `\r` inside
 * a longer chunk as a newline, so the message would sit unsent in the draft. A single line of text with one
 * trailing `\r` is submitted instead. A bracketed paste keeps its `\r` as a newline, and a chunk holding
 * several lines (an unbracketed paste) keeps today's behaviour; neither auto-submits.
 */
export function useComposerFilter({ composerActive, outputExpanded, draft, submit }: FilterOptions) {
  const { stdin } = useStdin();
  // Ink strips the paste markers before the key handler runs, so track them on the raw stream.
  const pasting = useRef(false);
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string) => {
      const chunk = data.toString();
      if (chunk.includes(PASTE_START)) pasting.current = true;
      // The chunk that ends a paste is still part of the paste; clear after the key handler has seen it.
      if (chunk.includes(PASTE_END)) setTimeout(() => (pasting.current = false), 50);
    };
    stdin.on('data', onData);
    return () => void stdin.off('data', onData);
  }, [stdin]);
  return (input: string, key: Key): boolean => {
    if (!composerActive || isShiftTab(input, key)) return true;
    if (!pasting.current && key.ctrl && input === 'u') {
      const cursor = draft.cursor.current;
      const start = cursor === 0 ? 0 : draft.value.lastIndexOf('\n', cursor - 1) + 1;
      draft.replace(draft.value.slice(0, start) + draft.value.slice(cursor), start);
      return true;
    }
    if (outputExpanded && key.escape) return true;
    if (['[I', '[O', '\x1b[I', '\x1b[O'].includes(input) || key.pageUp || key.pageDown) return true;
    if (key.ctrl && (key.upArrow || key.downArrow || ['g', 'b', 'o'].includes(input))) return true;
    // Legacy InputBox ignores Alt+Enter in the editor: it queues during a turn and inserts nothing when idle.
    if (key.meta && key.return) return true;
    const line = !pasting.current ? /^([^\r\n]+)\r$/.exec(input) : null;
    if (!line) return false;
    draft.replace('');
    submit(draft.value + line[1]);
    return true;
  };
}
