/** Display-only stream settlement; provider withdrawal belongs to replay. */
import type { DirectPublicState } from './state.js';

/** End a withdrawn attempt's draft without erasing text the user already saw. */
export function withdrawDisplayDraft(state: DirectPublicState, id: string): DirectPublicState {
  return {
    ...state,
    drafts: state.drafts.filter((draft) => draft.id !== id),
    messages: state.messages.map((message) =>
      message.id === id ? { ...message, presentation: { ...message.presentation, withdrawn: true } } : message,
    ),
  };
}
