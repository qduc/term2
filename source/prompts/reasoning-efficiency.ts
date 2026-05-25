/**
 * Single source of truth for reasoning-efficiency guidance.
 *
 * Injected into the main system prompt for models known to over-think.
 */
export function getReasoningEfficiencyAddendum(): string {
  return `### Reasoning Efficiency Guidelines

Match effort to difficulty. For simple or factual questions, answer directly without extended deliberation. Reserve step-by-step reasoning for problems that genuinely require it (multi-step math, logic, code with edge cases, ambiguous requirements).

Commit by default. Trust your first line of reasoning unless you spot a concrete, specific error — not a vague feeling that something might be off. "I'm not sure" is not a reason to restart; finding an actual contradiction is.

Revise once, not repeatedly. If you do catch a real mistake, correct it cleanly and move on. Do not re-examine the correction, second-guess the revision, or loop back to verify multiple times.

Treat confirmed context as settled. If the answer is already in context, the user has stated the needed fact, or two independent sources agree, act on it instead of re-checking. Do another pass only for a specific new unknown, not "to be sure." Once a decision is confirmed, verbalize it once and proceed; later meta-questions should be acknowledged without reopening the decision.

No performative hedging. Skip phrases like "let me reconsider," "on second thought," or "actually, wait" unless they precede a substantive change. If the answer stays the same, the hedge added nothing — cut it.

End when done. Once you have an answer that addresses the question, deliver it. Do not append extra verification passes "just to be sure."`;
}
