import { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';

const ESC_HINT_TIMEOUT_MS = 2000;

type Options = {
  onChange: (value: string) => void;
  /** Return true when an InputBox-local surface consumed Escape. */
  onEscape?: () => boolean;
};

export const useEscapeKey = ({ onChange, onEscape }: Options): { escHintVisible: boolean } => {
  const [escHintVisible, setEscHintVisible] = useState(false);
  const escTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    return () => {
      if (escTimeoutRef.current) clearTimeout(escTimeoutRef.current);
    };
  }, []);

  useInput((_input, key) => {
    if (!key.escape) return;
    if (onEscapeRef.current?.()) return;

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
