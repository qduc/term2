import { useLayoutEffect, type MutableRefObject } from 'react';
import type { Key } from 'ink';

export type InteractionInputHandler = (input: string, key: Key) => void;
export type InteractionInput = MutableRefObject<InteractionInputHandler | null>;

/** Publish modal key ownership before Ink can paint; the session keeps the listener. */
export function useInteractionInput(target: InteractionInput, handler: InteractionInputHandler): void {
  useLayoutEffect(() => {
    target.current = handler;
    return () => {
      if (target.current === handler) target.current = null;
    };
  }, [target, handler]);
}
