/** Stable collection updates used by the public wire-state reducer. */
import type { WireCommandReceipt, WireMessage, WireSnapshot } from './direct-wire.js';

export function timeline(
  state: WireSnapshot,
  entries: NonNullable<WireSnapshot['timeline']>,
  replacesDraftId?: string,
): WireSnapshot['timeline'] {
  if (state.timeline === null) return null;
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
type Identified = { readonly id: string };
export function replace<T extends Identified>(items: readonly T[], next: T): readonly T[] {
  return items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
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
export function message(items: readonly WireMessage[], next: WireMessage, draftId?: string): readonly WireMessage[] {
  const index = items.findIndex((item) => item.id === next.id || item.id === draftId);
  if (index < 0) return [...items, next];
  return items.flatMap((item, at) =>
    at === index ? [next] : item.id === next.id || item.id === draftId ? [] : [item],
  );
}
