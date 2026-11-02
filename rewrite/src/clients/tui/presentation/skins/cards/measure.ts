import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { measureElement, type DOMElement } from 'ink';

/**
 * The width, in columns, that the element this ref is attached to was actually given.
 *
 * Layouts that choose between forms (chips in a row or stacked, how many status pills fit)
 * need the room they really have: the card's inner width, not the terminal's, and a
 * terminal width is not always available to read (a one-shot render has no stdout). The
 * width is measured in a layout effect, whose state update is applied before anything is
 * painted, and `initial` is what is assumed for that first pass.
 *
 * `terminalColumns` is the caller's own reading of the terminal width. Its only job here is
 * to re-run the measurement when the terminal is resized, since the element's width can
 * change then and at no other time.
 */
export function useMeasuredWidth(initial: number, terminalColumns: number): [RefObject<DOMElement | null>, number] {
  const ref = useRef<DOMElement>(null);
  const [width, setWidth] = useState(initial);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const measured = measureElement(ref.current).width;
    // The updater form lets React drop an unchanged width without scheduling another render.
    if (measured > 0) setWidth((current) => (current === measured ? current : measured));
  }, [terminalColumns]);

  return [ref, width];
}
