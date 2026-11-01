/** Accepted turn answers survive queue settlement and reconnect after their message frame. */
import type { DirectSessionState } from '../session/facade-types.js';
import { contentText, publicContent, publicTerminal } from './direct-public.js';
import type { WireMessage, WireTerminal, WireTurnResult } from './direct-wire.js';

/** A streamed draft is not an accepted completed assistant answer. */
export function completedFinalText(outcome: WireTerminal['outcome'], messages: readonly WireMessage[]): string | null {
  return outcome === 'completed' ? messages.filter(message => message.role === 'assistant' && !message.draft).at(-1)?.text ?? null : null;
}
/** Use the native historical result window, not the current turn or queue disappearance. */
export function publicTurnResults(state: DirectSessionState, known: readonly WireMessage[]): readonly WireTurnResult[] {
  return state.turnResults.map(result => {
    const messages = result.messages.map(item => {
      const content = publicContent(item.content);
      const { presentation: _presentation, ...previous } = known.find(message => message.id === item.id) ?? {};
      const draft = state.drafts.find(message => message.id === item.id);
      return { ...previous, id: item.id, role: item.role, turnId: result.turnId, content, text: contentText(content),
        ...(item.presentation ? { presentation: structuredClone(item.presentation) } : {}),
        ...(draft ? { draft: true, modelStep: draft.modelStep } : {}) };
    });
    return { turnId: result.turnId, messages, ...publicTerminal(result), finalText: completedFinalText(result.outcome, messages) };
  });
}
