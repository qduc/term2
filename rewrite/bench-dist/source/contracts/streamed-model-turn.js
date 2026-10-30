/**
 * One response may carry several distinct assistant text parts (separate
 * message items or content parts). Adapters report which part a delta belongs
 * to via `partId`; the run loop separates distinct parts with this string in
 * both the streamed text and the committed history, so they never run together.
 */
export const ASSISTANT_TEXT_PART_SEPARATOR = '\n\n';
//# sourceMappingURL=streamed-model-turn.js.map