/** Per-turn detail a transcript shows after a reload: reasoning summaries in place, and each turn's usage. */
import type { WireEvent, WireSnapshot } from './wire-events.js';
import type { WireReasoningBlock } from './wire-types.js';

/** Records an accepted reasoning summary. A repeated id updates the text and keeps where it was first said. */
export function withReasoningBlock(
  state: WireSnapshot,
  event: Extract<WireEvent, { type: 'reasoning' }>,
): WireSnapshot {
  const blocks = state.reasoningBlocks ?? [];
  const known = blocks.findIndex((block) => block.messageId === event.payload.messageId);
  if (known >= 0)
    return {
      ...state,
      reasoningBlocks: blocks.map((block, index) => (index === known ? { ...block, text: event.payload.text } : block)),
    };
  const last = state.timeline?.at(-1);
  const block: WireReasoningBlock = {
    messageId: event.payload.messageId,
    turnId: event.turnId,
    modelStep: event.payload.modelStep,
    text: event.payload.text,
    after: last ? { kind: last.kind, id: last.id } : null,
  };
  return { ...state, reasoningBlocks: [...blocks, block] };
}

/** Records a turn's latest usage; one entry per turn, in the order turns first reported usage. */
export function withTurnUsage(state: WireSnapshot, event: Extract<WireEvent, { type: 'usage' }>): WireSnapshot {
  const turnId = event.turnId;
  if (turnId === null) return state;
  const entries = state.turnUsage ?? [];
  const entry = { turnId, usage: event.payload.usage };
  return {
    ...state,
    turnUsage: entries.some((item) => item.turnId === turnId)
      ? entries.map((item) => (item.turnId === turnId ? entry : item))
      : [...entries, entry],
  };
}

/** The snapshot without live reasoning; used wherever that text ends. */
export function withoutLiveReasoning(state: WireSnapshot): WireSnapshot {
  if (state.liveReasoning === undefined) return state;
  const { liveReasoning: _ended, ...rest } = state;
  return rest;
}
