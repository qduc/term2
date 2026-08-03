/**
 * The notice that opens a steering message — a user message delivered into a
 * turn that is already running, rather than as its own conversation turn.
 *
 * Without it the model reads an unannounced user message between a tool result
 * and its next action, and cannot tell whether it has been redirected or simply
 * handed the next task. The notice states both readings and what to do with
 * each. It is stripped from the message before the app displays or rewinds to
 * that turn, so only the user's own words are ever shown back to them.
 */
export const STEERING_NOTICE = `[Steering message: the user sent this while you were working, so it arrives mid-turn rather than as a new turn.
- If it changes what you should be doing, change direction now and drop the superseded plan.
- If it does not bear on the work in progress, treat it as the next task rather than an interruption: acknowledge it, finish what you are doing, and handle it after.]`;

/** Compose the model-facing text of a steering message. */
export function withSteeringNotice(text: string): string {
  return `${STEERING_NOTICE}\n\n${text}`;
}

/** Recover the user's own words from a steering message, if it is one. */
export function stripSteeringNotice(text: string): string {
  if (!text.startsWith(STEERING_NOTICE)) return text;
  return text.slice(STEERING_NOTICE.length).replace(/^\n+/, '');
}
