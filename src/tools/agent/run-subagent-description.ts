/**
 * The model-facing `run_subagent` tool description. Under the Bare profile this
 * is the main agent's only delegation guidance, so it carries both when to
 * delegate and how to write the task. It is product behavior.
 */
export function getRunSubagentDescription(backgroundEnabled: boolean): string {
  return (
    'Delegate a bounded task to a subagent (agent_spec for a custom agent, role for a preset). It runs in its own context and returns only a summary. ' +
    (backgroundEnabled
      ? '"foreground" (explorer and librarian only) returns the result in this call; "background" returns a handle now and notifies on completion, for long or parallel independent work.\n\n'
      : 'This session runs it in the foreground and returns the structured result in this turn.\n\n') +
    '## When to delegate\n' +
    'Default to doing the work yourself: investigating, implementing, testing and adjusting form one loop, since a test result can change the diagnosis. ' +
    "Delegate only a unit that separates cleanly: it can start without another unit's result, is useful on its own, and can be judged against the same criteria as its siblings. " +
    'Give parallel runs the same starting point, requirements and assumptions so their reports compare. ' +
    'Use a fresh reviewer when an independent judgment is worth the extra run.\n\n' +
    "You own the outcome: a report is a claim, not a result. Check its important claims against the evidence, resolve disagreements between runs, and finish the work. A reviewer's approval is not a guarantee.\n\n" +
    '## Task\n' +
    'The subagent does not see your conversation. Give one objective, ownership boundary and done condition, plus scope, non-discoverable findings or decisions, constraints, acceptance criteria and validation as applicable. ' +
    'Skip what it already gets: role instructions, tool guidance, worktree hygiene, environment, root `AGENTS.md`, skills.\n' +
    "- Explorer: concrete evidence for a bounded question; breadth or depth, never both. Not diagnosis, a fix recommendation, an approach choice, or the user's whole deliverable.\n" +
    '- Worker: one cohesive implementation unit.\n' +
    '- Mentor: one decision or challenge question.\n' +
    '- Reviewer: the artifact (diff range, files, plan), the original requirement as criteria, and concrete scenarios to check; label your own reasoning separately. It gathers evidence only through explorers.\n' +
    '- Librarian: one history question (memory, prior sessions) or one memory-maintenance topic.\n\n' +
    'For isolated worker edits, run `git worktree add .worktrees/<slug> -b <slug>` under the workspace root and pass its basename or branch as `worktree`; any writable agent may use it, and this session is not re-rooted.\n\n' +
    (backgroundEnabled
      ? 'A "running" status means the launch succeeded: do not relaunch or call get_subagent_result before the completion notification; end the turn and wait.'
      : 'Independent explorer and librarian calls in one response may run in parallel; keep worker and dependent calls serial. ' +
        'The result has status (completed, failed, cancelled, or interrupted), final text, tools used, and files changed.')
  );
}
