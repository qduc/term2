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
    if (!turnInFlight || value.length > 0) return;
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

    // An empty buffer during a turn belongs to the app-level interrupt
    // confirmation; clearing non-empty text still takes precedence.
    if (turnInFlight && value.length === 0) return;

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
