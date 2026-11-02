import { useEffect, useRef, useState } from 'react';
import { appendHistory, readHistory, type HistoryEntry } from './history.js';

type EditorDraft = HistoryEntry & { readonly cursor: number };

/** History preserves text, attachments and the unfinished draft's cursor while navigating. */
export function useEditor(initialHistory: readonly HistoryEntry[], historySize: number) {
  const [value, setValue] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const [cursorOverride, setCursorOverride] = useState<number | undefined>();
  const cursor = useRef(0);
  const [loaded] = useState(() => {
    try {
      return { entries: readHistory(historySize), error: null as string | null };
    } catch (error) {
      return {
        entries: [] as HistoryEntry[],
        error: `History unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  const history = useRef(loaded.entries.length ? loaded.entries : initialHistory.slice(-historySize));
  const [historyError, setHistoryError] = useState(loaded.error);
  const position = useRef(-1);
  const draft = useRef<EditorDraft>({ text: '', attachments: [], cursor: 0 });
  const valueRef = useRef(value);
  const revision = useRef(0);
  valueRef.current = value;
  useEffect(() => {
    history.current = history.current.slice(-historySize);
    position.current = -1;
  }, [historySize]);

  const change = (next: string) => {
    if (valueRef.current !== next) revision.current++;
    valueRef.current = next;
    setValue(next);
  };
  const replace = (next: string, at = next.length) => {
    change(next);
    cursor.current = at;
    setCursorOverride(at);
    setInputKey((key) => key + 1);
  };
  const cursorChanged = (offset: number) => {
    cursor.current = offset;
    if (cursorOverride === offset) setCursorOverride(undefined);
  };
  const navigate = (direction: 'up' | 'down' | 'left' | 'right', current: HistoryEntry): EditorDraft | null => {
    if (direction !== 'up' && direction !== 'down') return null;
    const entries = history.current;
    if (!entries.length || (direction === 'down' && position.current === -1)) return null;
    if (direction === 'up') {
      if (position.current === -1) draft.current = { ...current, cursor: cursor.current };
      position.current = position.current === -1 ? entries.length - 1 : Math.max(0, position.current - 1);
    } else {
      position.current += 1;
      if (position.current >= entries.length) position.current = -1;
    }
    const entry =
      position.current === -1
        ? draft.current
        : { ...entries[position.current], cursor: entries[position.current].text.length };
    return entry;
  };
  const accepted = (
    submitted: string,
    remember: boolean,
    attachments: HistoryEntry['attachments'] = [],
    expectedRevision?: number,
  ) => {
    const entry = { text: submitted, attachments };
    if (remember && (submitted.trim() || attachments.length)) {
      if (JSON.stringify(history.current.at(-1)) !== JSON.stringify(entry)) {
        history.current = [...history.current, entry].slice(-historySize);
      }
      try {
        appendHistory(entry, historySize);
        setHistoryError(null);
      } catch (error) {
        setHistoryError(`History not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    position.current = -1;
    draft.current = { text: '', attachments: [], cursor: 0 };
    if (valueRef.current === submitted && (expectedRevision === undefined || revision.current === expectedRevision))
      change('');
  };
  return {
    value,
    current: () => valueRef.current,
    revision: () => revision.current,
    change,
    replace,
    navigate,
    accepted,
    inputKey,
    historyError,
    cursorChanged,
    cursorOverride,
    cursor,
  };
}
