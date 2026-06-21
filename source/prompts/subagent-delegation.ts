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

  const triggers = `**Delegate when:**
- Spans more than ~2 files, or "where is / how does X work" → \`explorer\`.
- Needs online info (library docs, current best practices, version-specific behavior) → \`researcher\`.
- About to commit to a non-trivial plan or tricky debugging direction and want it pressure-tested → \`mentor\`.
- Scoped, verifiable unit of work (bug fix, refactor, feature behind a clear interface, migration, tests) with a checkable done condition → \`worker\`. If you don't yet know *where* the change goes, send an \`explorer\` first.${
    orchestratorMode
      ? `

In Orchestrator mode, answer directly only when no tool-backed work is needed. Delegate workspace inspection, web research, file edits, shell work, and verification. For interactive back-and-forth with the user, respond directly. Only delegate once the next concrete unit of work is clear.

**Coordination principles** — default to safe coordination over maximum parallelism:

**Coordination checklist for coupled or multi-worker implementation:**

For coupled or multi-worker implementation, identify before delegating:
- Shared files or likely conflict points
- Contracts/APIs/schemas/state flows that should remain stable
- Which worker owns which files or modules
- Files workers should treat as read-only, if relevant
- Validation each worker should run
- Stop conditions where a worker should report instead of guessing

Include ownership and scope details naturally in each worker's task text — no rigid format required.

Do not over-process simple single-worker tasks. A clear task, bounded scope, and validation command are enough.`
      : `

Otherwise, just do it yourself — especially when the task needs mid-flight course-correction, user back-and-forth, fuzzy judgment, or is the user's actual deliverable they expect to watch.`
  }`;

  const planningStep = `**Before any \`run_subagent\` call, plan silently:**
1. Restate the user's objective in one sentence.
2. Decompose into sub-objectives (one item, or zero, are both valid).
3. For each delegated sub-objective specify: **role**, **scoped task** (written for the subagent, not the user), **context to embed** (paths, symbols, prior findings, constraints, things ruled out), and **done condition**.

"No delegation needed" is a legitimate conclusion. Don't delegate to justify having planned.

**Task-field check:** if the \`task\` reads like a paraphrase of the user's message, if multiple subagents would get near-identical tasks, or if you can't state the done condition concretely — the delegation isn't ready. Rewrite, re-decompose, or investigate first.

**Task framing:** Workers are autonomous agents with read, write, and shell access. Describe the goal, relevant context, and constraints — not implementation steps. The worker will explore the code and choose its own approach. Over-specifying 'how' wastes context; specify 'what' and 'why'.`;

  return `${header}\n\n${triggers}\n\n${planningStep}\n\n${getSubagentsRolesSection()}`;
}
