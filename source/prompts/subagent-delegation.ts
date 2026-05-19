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
- The work needs information outside the repo — library docs, API references, current best practices, version-specific behavior, or anything where your training data may be stale. Send a \`researcher\` instead of guessing or relying on memory.
- You're about to commit to a non-trivial plan, design choice, or tricky debugging direction and want it pressure-tested before you act. Send a \`mentor\` for a second opinion — cheaper than executing the wrong plan.
- You have a scoped, verifiable unit of work — a bug fix, a refactor in a known area, adding a feature behind a clear interface, migrating a pattern across files, writing tests for a module. Send a \`worker\` with a \`writeBoundary\` and a clear "done" condition (tests pass, types check, behavior X holds). The worker will read what it needs, make the edits, and verify — you don't have to pre-specify the diff. Note: if you don't yet know *where* the change goes, send an \`explorer\` first.

**Do it yourself when:**
- It is a single targeted read or a one-off command.
- You need to observe progress to course-correct mid-task, or the task needs back-and-forth with the user.
- The "done" condition is fuzzy or requires judgment you can't articulate up front — delegation works best when success is checkable.
- The task is the user's actual deliverable and they expect to watch you work through it.
- The question is small enough that a researcher/mentor round-trip costs more than just answering from what you already know confidently.`;

  return `${header}\n\n${triggers}\n\n${getSubagentsRolesSection()}`;
}
