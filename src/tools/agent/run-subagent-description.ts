/**
 * The model-facing `run_subagent` tool description. Under the Bare profile this
 * is the main agent's only delegation guidance, so it carries both when to
 * delegate and how to write the task. It is product behavior.
 */
export function getRunSubagentDescription(backgroundEnabled: boolean): string {
  return (
    'Delegate a bounded task to the general agent runtime: use agent_spec for a custom agent, or role for a preset. ' +
    (backgroundEnabled
      ? 'execution "foreground" (explorer and librarian only) returns the result in this call: use it when your next step needs it. "background" returns a running handle and later a completion notification: use it for long or parallel independent work. '
      : 'This session uses foreground execution and returns the structured result in this turn. ') +
    'The subagent runs in its own context and returns only a summary.\n\n' +
    '## When to delegate\n' +
    'Do the work yourself by default. Investigating, implementing, testing and adjusting form one loop: a test result can change the diagnosis, so keep that loop in one agent. ' +
    "Delegate a unit only when it separates cleanly: it can start without another unit's result, it is useful on its own, and you can judge it against the same criteria as any sibling run. " +
    'Give parallel runs one shared starting point and the same requirements and assumptions, or their reports cannot be compared. ' +
    'Use a fresh reviewer when an independent judgment is worth the extra run.\n\n' +
    "You keep ownership of the outcome. A subagent's report is a claim, not a result: check its important claims against the evidence, resolve disagreements between runs yourself, and finish the work. A reviewer's approval is a separate check, not a guarantee.\n\n" +
    '## Task Requirements\n' +
    'The subagent does not see your conversation or reasoning. Give the task one clear objective, one ownership boundary, and one concrete done condition, plus the scope, non-discoverable findings or decisions, constraints, acceptance criteria, and validation when applicable. ' +
    'Do not repeat context it already gets: role instructions, tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or the skills catalog. ' +
    "Explorer: request concrete evidence for a bounded question and choose breadth or depth, never both (map one surface shallowly or trace one seam thoroughly); do not ask it to diagnose, recommend a fix, choose an approach, or own the user's whole investigation, review, diagnosis, or plan. " +
    'Worker: one cohesive implementation unit. Mentor: one decision or challenge question. ' +
    'Reviewer: the artifact to review (diff range, files, plan), the original requirement as the criteria, and concrete scenarios to check; label any of your own reasoning separately rather than presenting it as the requirement. It gathers evidence only through explorers. ' +
    'Librarian: one history question to answer from memory and prior sessions, or one memory-maintenance topic.\n\n' +
    'For isolated worker edits, first create a git worktree under the workspace root ' +
    '(`git worktree add .worktrees/<slug> -b <slug>`), then pass its directory basename or branch name as `worktree`; ' +
    'this pins the child there without re-rooting this session, and generic writable agents may use it too.\n\n' +
    (backgroundEnabled
      ? 'A background status of "running" means the launch succeeded: do not relaunch it, and do not call get_subagent_result before its completion notification arrives; end the turn and wait.'
      : 'Independent foreground explorer and librarian calls in the same response may run in parallel; keep worker calls and dependent tasks serial. ' +
        'Foreground returns a summary with status (completed, failed, cancelled, or interrupted), any final text, tools used, and files changed.')
  );
}
