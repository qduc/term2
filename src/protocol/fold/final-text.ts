/** The accepted answer a turn ended with. */
import type { WireMessage, WireTerminal } from './wire-types.js';

/** Neither a streamed draft nor a withdrawn attempt is an accepted completed assistant answer. */
export function completedFinalText(outcome: WireTerminal['outcome'], messages: readonly WireMessage[]): string | null {
  return outcome === 'completed'
    ? messages
        .filter((message) => message.role === 'assistant' && !message.draft && message.presentation?.withdrawn !== true)
        .at(-1)?.text ?? null
    : null;
}
