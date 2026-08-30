import { getSubagentsRolesSection } from '../tools/agent/run-subagent.js';

/**
 * Single source of truth for model-facing subagent delegation.
 * The tool name stays stable; `execution` identifies the lifecycle available in
 * this session.
 */
export function getSubagentDelegationAddendum({
  orchestratorMode = false,
  foregroundEnabled = true,
  backgroundEnabled = false,
  controlsEnabled = false,
}: {
  orchestratorMode?: boolean;
  memoryEnabled?: boolean;
  foregroundEnabled?: boolean;
  backgroundEnabled?: boolean;
  controlsEnabled?: boolean;
} = {}): string {
  const executions = backgroundEnabled
    ? '- `execution: "background"`: the only execution mode in this session. It starts a conversation-scoped run and returns `{ runId, status: "running" }` immediately.'
    : foregroundEnabled
    ? '- `execution: "foreground"`: the only execution mode in this session. It runs through the nested subagent path and returns its structured result in this turn.'
    : '';

  const header = `### Delegating to subagents

You have one \`run_subagent\` tool. A subagent runs in its own context and returns only a summary, keeping your own context focused on high-level reasoning. Its required \`execution\` field identifies the only lifecycle available in this session:

${executions}`;

  const triggers = `**Delegate when it provides meaningful leverage:**
- Need bounded evidence collection, context compression, or current external information (library docs, best practices, version-specific behavior) → \`explorer\`.
${
  backgroundEnabled
    ? '- About to commit to a non-trivial plan or tricky debugging direction and want it pressure-tested → `mentor`.\n'
    : ''
}- Have a cohesive, separable implementation or review unit with a checkable done condition → \`worker\`.

Explorer is an evidence collector, not a reasoning delegate. Ask it to locate and organize concrete facts, files, symbols, logs, tests, or sources for a bounded question. Do not pass the user's entire investigation, diagnosis, review, or planning task to explorer. You retain responsibility for hypotheses, causal analysis, judgments, and recommendations.${
    orchestratorMode
      ? `

In Orchestrator mode, delegate for specialization, context compression, safe parallelism, or cohesive separable work. Delegation transfers execution, never outcome ownership: integrate results, follow up, correct errors, and finish the user outcome. Avoid concurrent overlapping edits; sequence coupled work and validate proportionately to its risk.`
      : `

Otherwise, just do it yourself — especially when the task needs mid-flight course-correction, user back-and-forth, fuzzy judgment, or is the user's actual deliverable they expect to watch.`
  }`;

  const backgroundRules = backgroundEnabled
    ? `**Background execution rules:**
- A returned handle with \`status: "running"\` means delegation succeeded. Do not duplicate or independently perform the delegated unit.
- Do NOT call \`get_subagent_result\` immediately after a background launch. Active runs are refused rather than awaited. End the current turn and wait for the completion notification, which inlines the full result so you can continue directly.
- Fresh background runs support explorer, worker, and mentor. They persist across ordinary parent-turn completion in process memory until the 30-minute sliding TTL expires or the 50-session cap evicts them.
- Use \`get_subagent_result\` only with the exact \`runId\` from a completed run when you need to re-fetch a result already received. Mentor fresh calls reuse their default session; explorer fresh calls start a new session. Worker runs are always fresh and cannot be continued. Only completed non-worker runs support \`continue_run_id\`; do not invent runIds or continue active, failed, cancelled, missing, or evicted runs.${
        controlsEnabled
          ? `
- Address \`send_message\` and \`cancel_run\` by the active name or runId; runId remains canonical. \`send_message\` non-blockingly steers an active execution run or answers a waiting \`ask_orchestrator\` question with \`reply_to\`; \`cancel_run\` non-blockingly requests cancellation.
- Steering never waits for a result. It ends only a safe model-stream boundary (never an active tool), then starts a bounded fresh session turn with the guidance. This is not SDK live injection or RunState continuation. A run accepts a maximum of three continuation segments. Mentor runs do not support steering; cancel them if needed.
- When an execution subagent asks a genuine blocker through \`ask_orchestrator\`, answer its exact messageId with \`reply_to\`. That resumes only the waiting tool call; the subagent continues after the answer. Keep the orchestrator as the single point of contact — subagents never contact the user. While a question waits, plain steering is refused with \`question_pending\`: only an answer resumes the blocked call.
- Both controls return acknowledgements immediately. Do not retrieve a result immediately after either control.`
          : ''
      }`
    : '';

  const planningStep = `**Task framing:** Choose delegation deliberately; "no delegation needed" is a legitimate conclusion. The orchestrator decides where execution units begin and end. Workers retain autonomy over how to complete their assigned unit. Workers are autonomous agents with read, write, and shell access. Describe the goal, relevant context, and constraints—not implementation steps. A worker task should be one cohesive unit that can be understood, implemented, and verified without owning an entire multi-stage plan.

Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root \`AGENTS.md\`, or skills catalog. The subagent does not see your conversation or reasoning, so include only objective, task-specific scope, non-discoverable parent findings or decisions, constraints, deliverable or acceptance criteria, and validation when applicable.`;

  return `${header}\n\n${triggers}${
    backgroundRules ? `\n\n${backgroundRules}` : ''
  }\n\n${planningStep}\n\n${getSubagentsRolesSection({
    includeLibrarian: false,
    includeMentor: backgroundEnabled,
  })}`;
}
