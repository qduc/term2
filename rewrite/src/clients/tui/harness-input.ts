import { useEffect } from 'react';
import { publishHarnessInputState } from '../../../../source/lib/harness-input-idle.js';

/** Acknowledge the committed native composer; never publish idle for a panel or active turn. */
export function useHarnessInput(active: boolean, processing: boolean, value: string): void {
  useEffect(() => {
    publishHarnessInputState({ owner: active ? 'input' : 'menu', processing, inputValue: value });
  }, [active, processing, value]);
}
