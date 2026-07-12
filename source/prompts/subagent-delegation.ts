import { getSubagentsRolesSection } from '../tools/agent/run-subagent.js';

/**
 * Single source of truth for the agent-facing delegation guidance.
 *
 * Injected into the main system prompt whenever `run_subagent` is available.
 * The tool description covers mechanics; behavioral guidance lives here.
 */
export function getSubagentDelegationAddendum({
  orchestratorMode = false,
}: { orchestratorMode?: boolean } = {}): string {
  const header = `### Delegating to subagents

You have a \`run_subagent\` tool. A subagent runs in its own context and returns only a summary — use it to keep your own context focused on high-level reasoning.`;

  const triggers = `**Delegate when it provides meaningful leverage:**
- Need focused codebase investigation or context compression → \`explorer\`.
- Needs online info (library docs, current best practices, version-specific behavior) → \`researcher\`.
- About to commit to a non-trivial plan or tricky debugging direction and want it pressure-tested → \`mentor\`.
- Need relevant persistent-memory context or memory maintenance → \`librarian\`.
- Have a cohesive, separable implementation or review unit with a checkable done condition → \`worker\`.${
    orchestratorMode
      ? `

In Orchestrator mode, directly inspect, edit, run commands, and test small or clear work when delegation has no meaningful leverage. Delegate for specialization, context compression, safe parallelism, or cohesive separable work. Delegation transfers execution, never outcome ownership: integrate results, follow up, correct errors, and finish the user outcome. Avoid concurrent overlapping edits; sequence coupled work and validate proportionately to its risk.`
      : `

Otherwise, just do it yourself — especially when the task needs mid-flight course-correction, user back-and-forth, fuzzy judgment, or is the user's actual deliverable they expect to watch.`
  }`;

  const planningStep = `**Task framing:** Choose delegation deliberately; "no delegation needed" is a legitimate conclusion. The orchestrator decides where execution units begin and end. Workers retain autonomy over how to complete their assigned unit. Workers are autonomous agents with read, write, and shell access. Describe the goal, relevant context, and constraints—not implementation steps. A worker task should be one cohesive unit that can be understood, implemented, and verified without owning an entire multi-stage plan.

Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root \`AGENTS.md\`, or skills catalog. The subagent does not see your conversation or reasoning, so include only objective, task-specific scope, non-discoverable parent findings or decisions, constraints, deliverable or acceptance criteria, and validation when applicable.`;

  return `${header}\n\n${triggers}\n\n${planningStep}\n\n${getSubagentsRolesSection()}`;
}
