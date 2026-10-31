import { useRef, useState } from 'react';
import { appendHistory, readHistory } from './history.js';

/** Session-local editor history. Navigation restores the unfinished draft at the end. */
export function useEditor(initialHistory: readonly string[]) {
  const [value, setValue] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const [loaded] = useState(() => {
    try { return { entries: readHistory(), error: null as string | null }; }
    catch (error) { return { entries: [] as string[], error: `History unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
  });
  const history = useRef(loaded.entries.length ? loaded.entries : [...initialHistory]);
  const [historyError, setHistoryError] = useState(loaded.error);
  const position = useRef(-1);
  const draft = useRef('');
  const valueRef = useRef(value);
  valueRef.current = value;

  const change = (next: string) => {
    valueRef.current = next;
    setValue(next);
  };
  const navigate = (direction: 'up' | 'down' | 'left' | 'right') => {
    if (direction !== 'up' && direction !== 'down') return;
    const entries = history.current;
    if (!entries.length || (direction === 'down' && position.current === -1)) return;
    if (direction === 'up') {
      if (position.current === -1) draft.current = valueRef.current;
      position.current = position.current === -1 ? entries.length - 1 : Math.max(0, position.current - 1);
    } else {
      position.current += 1;
      if (position.current >= entries.length) position.current = -1;
    }
    change(position.current === -1 ? draft.current : entries[position.current]);
    // ink-prompt owns the cursor; remounting resets it after replacing the buffer,
    // the same approach used by the current InputBox history navigation.
    setInputKey(key => key + 1);
  };
  const accepted = (submitted: string, remember: boolean) => {
    if (remember && submitted.trim() && history.current.at(-1) !== submitted) {
      history.current.push(submitted);
      try { appendHistory(submitted); setHistoryError(null); }
      catch (error) { setHistoryError(`History not saved: ${error instanceof Error ? error.message : String(error)}`); }
    }
    position.current = -1;
    draft.current = '';
    // Do not erase a draft edited while the admission was in flight.
    if (valueRef.current === submitted) change('');
  };
  return { value, change, navigate, accepted, inputKey, historyError };
}
