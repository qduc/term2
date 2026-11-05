import { useState } from 'react';
import type { Key } from 'ink';

/**
 * Legacy useShellMode and InputBox: `!` on an empty composer swaps the prompt for a red `!` (the `!` is not
 * typed); Escape or Backspace on the empty shell prompt leaves it, and a command leaves it once it has run.
 */
export function useShellMode(value: string, replaceInput: (text: string) => void) {
  const [active, setActive] = useState(false);
  return {
    active,
    /** The editor's change; true when it entered shell mode instead. */
    change(next: string): boolean {
      if (active || value !== '' || !next.startsWith('!')) return false;
      setActive(true);
      replaceInput(next.slice(1));
      return true;
    },
    /** The editor's Enter; true when shell mode took it. A blank command stays in shell mode. */
    submit(text: string, hasImages: boolean, run: (command: string) => Promise<void>): boolean {
      if (!active || hasImages) return false;
      if (!text.trim()) return true;
      replaceInput('');
      void run(`!${text}`).finally(() => setActive(false));
      return true;
    },
    /** Backspace on the empty shell prompt; true when it was consumed. */
    key(input: string, key: Key): boolean {
      if (!active || value !== '' || !(key.backspace || key.delete || input === '\x7f' || input === '\b')) return false;
      setActive(false);
      return true;
    },
    escape(): boolean {
      if (!active || value !== '') return false;
      setActive(false);
      return true;
    },
  };
}
