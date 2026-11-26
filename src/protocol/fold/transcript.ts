/** The ordered transcript entries every client draws: messages, the streaming draft and the timeline. */
import { appendedNotice } from './reducer-notices.js';
import type { WireCommandReceipt, WireEvent, WireMessage, WireSnapshot } from './wire-types.js';

export function timeline(
  state: WireSnapshot,
  entries: NonNullable<WireSnapshot['timeline']>,
  replacesDraftId?: string,
): WireSnapshot['timeline'] {
  if (state.timeline === null) return null;
  // A streaming delta re-announces the entry already at the tail; ids are unique, so nothing changes.
  if (replacesDraftId === undefined && entries.length === 1) {
    const last = state.timeline.at(-1);
    if (last && last.kind === entries[0]!.kind && last.id === entries[0]!.id) return state.timeline;
  }
  let next = [...state.timeline];
  for (const entry of entries) {
    const index = next.findIndex(
      (item) => item.kind === entry.kind && (item.id === entry.id || item.id === replacesDraftId),
    );
    if (index < 0) next.push(entry);
    else
      next = next.flatMap((item, at) =>
        at === index
          ? [entry]
          : item.kind === entry.kind && (item.id === entry.id || item.id === replacesDraftId)
          ? []
          : [item],
      );
  }
  return next;
}
/** Receipt updates keep their original acceptance slot, just like native state. */
export function commandReceipts(
  items: readonly WireCommandReceipt[],
  next: WireCommandReceipt,
): readonly WireCommandReceipt[] {
  const id = next.request.commandId;
  return items.some((item) => item.request.commandId === id)
    ? items.map((item) => (item.request.commandId === id ? next : item))
    : [...items, next];
}
/** A snapshot with one more notice line, anchored to the accepted row it followed. */
export const withNotice = (state: WireSnapshot, kind: string, message: string): WireSnapshot => ({
  ...state,
  notices: [...state.notices, appendedNotice(state, kind, message)],
});
export function message(items: readonly WireMessage[], next: WireMessage, draftId?: string): readonly WireMessage[] {
  // The streaming draft is the last message; replace it without scanning or rebuilding every item.
  if (draftId === undefined && items.at(-1)?.id === next.id) return [...items.slice(0, -1), next];
  const index = items.findIndex((item) => item.id === next.id || item.id === draftId);
  if (index < 0) return [...items, next];
  return items.flatMap((item, at) =>
    at === index ? [next] : item.id === next.id || item.id === draftId ? [] : [item],
  );
}
export function delta(state: WireSnapshot, event: Extract<WireEvent, { type: 'text_delta' }>): WireSnapshot {
  const payload = event.payload;
  const last = state.messages.at(-1);
  const previous = last?.id === payload.messageId ? last : state.messages.find((item) => item.id === payload.messageId);
  const text = (previous?.text ?? '') + payload.delta;
  return {
    ...state,
    thinking: false,
    timeline: timeline(state, [{ kind: 'message', id: payload.messageId }]),
    messages: message(state.messages, {
      id: payload.messageId,
      role: 'assistant',
      content: [{ type: 'text', text }],
      text,
      draft: true,
      ...(event.turnId ? { turnId: event.turnId } : {}),
      modelStep: payload.modelStep,
    }),
  };
}
