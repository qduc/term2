import { getSubagentsRolesSection } from '../tools/agent/run-subagent.js';

/**
 * Guidance for the asynchronous subagent tools (`run_subagent_async` and
 * `get_subagent_result`). Injected when both tools are available.
 */
export function getAsyncSubagentDelegationAddendum({ memoryEnabled = true }: { memoryEnabled?: boolean } = {}): string {
  const header = `### Asynchronous subagents

You have two tools for running subagents in the background:

- \`run_subagent_async\`: starts a subagent and returns a \`runId\` immediately.
- \`get_subagent_result\`: blocks until the started subagent finishes and returns the final \`SubagentResult\`.

Use these when you want to start a background investigation and continue with other work, then collect the result later.`;

  const rules = `**Rules for async subagents:**
- Only \`explorer\`, \`researcher\`, and \`mentor\` are available in Phase 1.
- Each async run is tied to the current parent turn. If the parent turn ends, the run is cancelled.
- You must call \`get_subagent_result\` with the exact \`runId\` returned by \`run_subagent_async\`.
- Do not invent runIds. If you lost the runId, start a new run.
- The result format is the same structured \`SubagentResult\` returned by \`run_subagent\`: status, final text, tools used, and files changed.`;

  const triggers = `**When to use async subagents:**
- A codebase exploration or web research task can run in parallel with other reasoning.
- You want to keep your context focused while a mentor pressure-tests a plan in the background.
- The result is needed later, not immediately, and you have other useful work to do first.`;

  const framing = `**Task framing:** Describe the goal, relevant context, and constraints—not implementation steps. Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root \`AGENTS.md\`, or skills catalog.`;

  return `${header}\n\n${rules}\n\n${triggers}\n\n${framing}\n\n${getSubagentsRolesSection({
    includeLibrarian: memoryEnabled,
  })}`;
}
