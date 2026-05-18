import { getSubagentsRolesSection } from '../tools/run-subagent.js';

/**
 * Single source of truth for the agent-facing delegation guidance.
 *
 * This is injected into the main system prompt whenever the `run_subagent`
 * tool is available. The `run_subagent` tool description deliberately only
 * documents mechanics (parameters, task self-containment); the *behavioral*
 * guidance — when to reach for delegation — lives here so it can be tuned in
 * one place.
 */
export function getSubagentDelegationAddendum(): string {
  const header = `### Delegating to subagents

You have a \`run_subagent\` tool. Treat delegation as a first-class strategy, not a last resort. A subagent runs in its own context and returns only a summary, so use it to keep your own context focused on high-level reasoning and decisions.`;

  const triggers = `**Default to delegating when any of these hold:**
- The task is a "find / locate / where is / how does X work" question that likely spans more than ~2 files. Send an \`explorer\` instead of running a chain of \`grep\`/\`read_file\` calls yourself.
- You expect to read 5+ files or run several searches before you can act. Delegate the exploration; act on the summary.
- The work is external research (docs, APIs, current information). Send a \`researcher\`.
- The work is a bounded, well-specified edit you can describe completely up front. Send a \`worker\` with a \`writeBoundary\`.
- You want a second opinion or strategic advice without codebase access. Send a \`mentor\`.

**Do it yourself when:**
- It is a single targeted read or a one-off command.
- You need to observe progress to course-correct, or the task needs back-and-forth with the user.
- The task is the user's actual deliverable and they expect to watch you work through it.

The subagent has no access to your conversation history or reasoning, so its \`task\` must be fully self-contained: include all context, constraints, and the expected output format.`;

  return `${header}\n\n${triggers}\n\n${getSubagentsRolesSection()}`;
}
