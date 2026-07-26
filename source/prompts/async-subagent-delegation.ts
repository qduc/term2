import { getSubagentsRolesSection } from '../tools/agent/run-subagent.js';

/**
 * Guidance for the asynchronous subagent tools (`run_subagent_async` and
 * `get_subagent_result`). Injected when both tools are available.
 */
export function getAsyncSubagentDelegationAddendum({
  memoryEnabled = true,
  orchestratorMode = false,
  controlsEnabled = false,
}: { memoryEnabled?: boolean; orchestratorMode?: boolean; controlsEnabled?: boolean } = {}): string {
  const header = `### Asynchronous subagents

You have the following tools for running and controlling background subagents:

- \`run_subagent_async\`: starts a subagent and returns a \`runId\` immediately — the call does NOT block.
- \`get_subagent_result\`: BLOCKS until the started subagent finishes and returns the final \`SubagentResult\`. Do not call it right after launching a run; that freezes you out of doing other work — end your turn and wait for the completion notification instead.
${
  controlsEnabled
    ? `- \`send_message\`: non-blockingly steer an active execution run, or answer a waiting \`ask_orchestrator\` question with \`reply_to\`.
- \`cancel_run\`: non-blockingly request two-phase cancellation of an active run; its eventual partial result still arrives through normal completion.`
    : ''
}

Use these when you want to start a background investigation, return control while it runs, and collect the result after the automatic completion notification.`;

  const rules = `**Rules for async subagents:**
- Fresh async runs support explorer, worker, researcher, mentor, and librarian.
- Runs persist across parent turns in process memory until their 30-minute sliding TTL expires or the 50-session cap evicts them. Ordinary turn completion does not cancel them.
- A returned handle with \`status: "running"\` means delegation succeeded.
- Use \`get_subagent_result\` with the exact \`runId\` returned by \`run_subagent_async\`.
- Do NOT call \`get_subagent_result\` immediately after \`run_subagent_async\` returns — it blocks until completion and freezes you out of doing other work or receiving the next user instruction. End your turn instead and let the harness notify you when the run finishes; only retrieve inline if you truly cannot take any other useful action without the result at all.
- Mentor and librarian fresh calls reuse their default session. Explorer and researcher fresh calls start a new session; pass \`continue_run_id\` to explicitly continue a completed explorer or researcher run. Worker runs are always fresh and cannot be continued.
- Only completed runs can be continued. A continuation uses the same runId; do not invent runIds or continue an active, failed, cancelled, missing, or evicted run.
- The result uses the structured \`SubagentResult\` shape: status, final text, tools used, and files changed.`;

  const controls = controlsEnabled
    ? `**Controlling a live async run:**
- Address \`send_message\` and \`cancel_run\` by the active name or runId; runId remains canonical. Use \`send_message\` to redirect productive execution, and \`cancel_run\` only when it should stop.
- Steering never waits for a result. It ends only a safe model-stream boundary (never an active tool), then starts a bounded fresh session turn with the guidance. This is not SDK live injection or RunState continuation.
- A run accepts a maximum of three continuation segments. Mentor runs do not support steering; cancel them if needed.
- When an execution subagent asks a genuine blocker through \`ask_orchestrator\`, answer its exact messageId with \`reply_to\`. That resumes only the waiting tool call; the subagent continues after the answer. Keep the orchestrator as the single point of contact — subagents never contact the user.
- Both controls return acknowledgements immediately. Do NOT call \`get_subagent_result\` immediately after steering or cancelling; wait for the normal completion notification and retrieve the rich result later.`
    : '';

  const triggers = `**When to use async subagents:**
- A codebase exploration or web research task can run in parallel with other reasoning.
- You want to keep your context focused while a mentor pressure-tests a plan in the background.
- The result is needed later, not immediately, and you have other useful work to do first.${
    orchestratorMode
      ? `

In Orchestrator mode, use \`run_subagent_async\` for delegable work. A returned handle with \`status: "running"\` means delegation succeeded. Do not duplicate or independently perform the delegated unit. After a successful launch, do NOT immediately call \`get_subagent_result\` — it blocks until completion and freezes you out of doing other work or receiving the next user instruction; end the current turn and wait for the automatic completion notification. Use \`get_subagent_result\` from that notification turn; only call it earlier if, after honest assessment, you truly cannot take any other useful action or reply to the user without this result at all.`
      : ''
  }`;

  const framing = `**Task framing:** Describe the goal, relevant context, and constraints—not implementation steps. Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root \`AGENTS.md\`, or skills catalog.`;

  return `${header}\n\n${rules}${
    controls ? `\n\n${controls}` : ''
  }\n\n${triggers}\n\n${framing}\n\n${getSubagentsRolesSection({
    includeLibrarian: memoryEnabled,
  })}`;
}
