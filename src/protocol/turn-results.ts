/** Accepted turn answers survive queue settlement and reconnect after their message frame. */
import type { DirectSessionState } from '../session/facade-types.js';
import { contentText, publicContent, publicTerminal } from './public.js';
import type { WireMessage, WireTerminal, WireTurnResult } from './wire.js';

/** Neither a streamed draft nor a withdrawn attempt is an accepted completed assistant answer. */
export function completedFinalText(outcome: WireTerminal['outcome'], messages: readonly WireMessage[]): string | null {
  return outcome === 'completed'
    ? messages
        .filter((message) => message.role === 'assistant' && !message.draft && message.presentation?.withdrawn !== true)
        .at(-1)?.text ?? null
    : null;
}
/** Use the native historical result window, not the current turn or queue disappearance. */
export function publicTurnResults(state: DirectSessionState, known: readonly WireMessage[]): readonly WireTurnResult[] {
  const knownById = new Map<string, WireMessage>();
  for (const message of known) if (!knownById.has(message.id)) knownById.set(message.id, message);
  const drafts = new Map<string, (typeof state.drafts)[number]>();
  for (const draft of state.drafts) if (!drafts.has(draft.id)) drafts.set(draft.id, draft);
  return state.turnResults.map((result) => {
    const messages = result.messages.map((item) => {
      const content = publicContent(item.content);
      const { presentation: _presentation, ...previous } = knownById.get(item.id) ?? {};
      const draft = drafts.get(item.id);
      return {
        ...previous,
        id: item.id,
        role: item.role,
        turnId: result.turnId,
        content,
        text: contentText(content),
        ...(item.presentation ? { presentation: structuredClone(item.presentation) } : {}),
        ...(item.presentation?.withdrawn === true
          ? { draft: false }
          : draft
          ? { draft: true, modelStep: draft.modelStep }
          : {}),
      };
    });
    return {
      turnId: result.turnId,
      messages,
      ...publicTerminal(result),
      finalText: completedFinalText(result.outcome, messages),
    };
  });
}
