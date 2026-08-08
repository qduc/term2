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
    setEscHintVisible(false);
  }, [turnInFlight, value]);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (onEscapeRef.current?.()) return;

    // An empty buffer during a turn belongs to the app-level interrupt
    // confirmation; clearing non-empty text still takes precedence.
    if (turnInFlight && value.length === 0) return;

    // Double ESC clears text buffer.
    if (escHintVisible) {
      if (escTimeoutRef.current) {
        clearTimeout(escTimeoutRef.current);
        escTimeoutRef.current = null;
      }
      setEscHintVisible(false);
      onChange('');
      return;
    }

    setEscHintVisible(true);
    escTimeoutRef.current = setTimeout(() => {
      setEscHintVisible(false);
      escTimeoutRef.current = null;
    }, ESC_HINT_TIMEOUT_MS);
  });

  return { escHintVisible };
};
