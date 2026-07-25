import { getSubagentsRolesSection } from '../tools/agent/run-subagent.js';

/**
 * Guidance for the asynchronous subagent tools (`run_subagent_async` and
 * `get_subagent_result`). Injected when both tools are available.
 */
export function getAsyncSubagentDelegationAddendum({
  memoryEnabled = true,
  orchestratorMode = false,
}: { memoryEnabled?: boolean; orchestratorMode?: boolean } = {}): string {
  const header = `### Asynchronous subagents

You have two tools for running subagents in the background:

- \`run_subagent_async\`: starts a subagent and returns a \`runId\` immediately.
- \`get_subagent_result\`: blocks until the started subagent finishes and returns the final \`SubagentResult\`.

Use these when you want to start a background investigation and continue with other work, then collect the result later.`;

  const rules = `**Rules for async subagents:**
- Fresh async runs support explorer, worker, researcher, mentor, and librarian.
- Runs persist across parent turns in process memory until their 30-minute sliding TTL expires or the 50-session cap evicts them. Ordinary turn completion does not cancel them.
- You must call \`get_subagent_result\` with the exact \`runId\` returned by \`run_subagent_async\`.
- Mentor and librarian fresh calls reuse their default session. Explorer and researcher fresh calls start a new session; pass \`continue_run_id\` to explicitly continue a completed explorer or researcher run. Worker runs are always fresh and cannot be continued.
- Only completed runs can be continued. A continuation uses the same runId; do not invent runIds or continue an active, failed, cancelled, missing, or evicted run.
- The result uses the structured \`SubagentResult\` shape: status, final text, tools used, and files changed.`;

  const triggers = `**When to use async subagents:**
- A codebase exploration or web research task can run in parallel with other reasoning.
- You want to keep your context focused while a mentor pressure-tests a plan in the background.
- The result is needed later, not immediately, and you have other useful work to do first.${
    orchestratorMode
      ? `

In Orchestrator mode, use \`run_subagent_async\` for delegable work and return control after receiving the run handle. When the result is truly needed immediately, call \`get_subagent_result\` with that handle.`
      : ''
  }`;

  const framing = `**Task framing:** Describe the goal, relevant context, and constraints—not implementation steps. Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root \`AGENTS.md\`, or skills catalog.`;

  return `${header}\n\n${rules}\n\n${triggers}\n\n${framing}\n\n${getSubagentsRolesSection({
    includeLibrarian: memoryEnabled,
  })}`;
}
