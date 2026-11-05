/** Copied from legacy source/hooks/use-escape-key.ts: double Escape clears the composer draft. */
import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';

const ESC_HINT_TIMEOUT_MS = 2000;

type Options = {
  value: string;
  onChange: (value: string) => void;
  /** Return true when an InputBox-local surface consumed Escape. */
  onEscape?: () => boolean;
  turnInFlight?: boolean;
};

export const useEscapeKey = ({
  value,
  onChange,
  onEscape,
  turnInFlight = false,
}: Options): { escHintVisible: boolean } => {
  const [escHintVisible, setEscHintVisible] = useState(false);
  const escHintVisibleRef = useRef(false);
  const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    return () => {
      if (escTimeoutRef.current) clearTimeout(escTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (turnInFlight && value.length === 0) return;
    if (escTimeoutRef.current) {
      clearTimeout(escTimeoutRef.current);
      escTimeoutRef.current = null;
    }
    escHintVisibleRef.current = false;
    setEscHintVisible(false);
  }, [turnInFlight, value]);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (onEscapeRef.current?.()) return;

    // Legacy has the same early return for an empty buffer during a turn, but its InputBox handler sees the
    // turnInFlight of the render that mounted the editor (traced: false while streaming), so the clear-input
    // hint shows beside the interrupt confirmation. Reproduced here by not returning.

    // Ink parses two ESC bytes delivered in one terminal chunk as a single
    // meta+escape key. Treat that representation as the second press too.
    const isDoubleEscape = key.meta === true;

    // Double ESC clears text buffer.
    if (escHintVisibleRef.current || isDoubleEscape) {
      if (escTimeoutRef.current) {
        clearTimeout(escTimeoutRef.current);
        escTimeoutRef.current = null;
      }
      escHintVisibleRef.current = false;
      setEscHintVisible(false);
      onChange('');
      return;
    }

    escHintVisibleRef.current = true;
    setEscHintVisible(true);
    escTimeoutRef.current = setTimeout(() => {
      escHintVisibleRef.current = false;
      setEscHintVisible(false);
      escTimeoutRef.current = null;
    }, ESC_HINT_TIMEOUT_MS);
  });

  return { escHintVisible };
};
