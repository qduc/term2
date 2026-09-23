/**
 * The notice that opens a steering message — a user message delivered into a
 * turn that is already running, rather than as its own conversation turn.
 *
 * Without it the model reads an unannounced user message between a tool result
 * and its next action, and cannot tell whether it has been redirected or simply
 * handed a side question or the next task. The notice preserves the active
 * objective unless explicitly replaced. It is stripped before the app displays or rewinds to
 * that turn, so only the user's own words are ever shown back to them.
 */
export const STEERING_NOTICE = `[Steering message: the user sent this while you were working, so it arrives mid-turn rather than as a new turn.
- For status or side questions, emit a brief answer to the user before your next tool call, then continue the pending work in the same response.
- Incorporate corrections and new constraints while preserving the active objective, unless the user explicitly pauses, cancels, or replaces it. Drop only superseded work.
- For an unrelated task, acknowledge it, finish the active task, then handle it unless the user explicitly changes priority.]`;

// Saved conversations can still contain either previous notice.
const PREVIOUS_STEERING_NOTICE = `[Steering message: the user sent this while you were working, so it arrives mid-turn rather than as a new turn.
- For status or side questions, answer briefly, then resume the active task.
- Incorporate corrections and new constraints while preserving the active objective, unless the user explicitly pauses, cancels, or replaces it. Drop only superseded work.
- For an unrelated task, acknowledge it, finish the active task, then handle it unless the user explicitly changes priority.]`;

const LEGACY_STEERING_NOTICE = `[Steering message: the user sent this while you were working, so it arrives mid-turn rather than as a new turn.
- If it changes what you should be doing, change direction now and drop the superseded plan.
- If it does not bear on the work in progress, treat it as the next task rather than an interruption: acknowledge it, finish what you are doing, and handle it after.]`;

/** Compose the model-facing text of a steering message. */
export function withSteeringNotice(text: string): string {
  return `${STEERING_NOTICE}\n\n${text}`;
}

/** Recover the user's own words from a steering message, if it is one. */
export function stripSteeringNotice(text: string): string {
  const notice = [STEERING_NOTICE, PREVIOUS_STEERING_NOTICE, LEGACY_STEERING_NOTICE].find((prefix) =>
    text.startsWith(prefix),
  );
  return notice ? text.slice(notice.length).replace(/^\n+/, '') : text;
}
