/**
 * The model-facing `run_subagent` tool description. Under the Bare profile this
 * is the main agent's only delegation guidance, so it carries both when to
 * delegate and how to write the task. It is product behavior.
 */
export function getRunSubagentDescription(backgroundEnabled: boolean): string {
  return (
    'Delegate a bounded task to the general agent runtime. Use agent_spec for dynamic goal/context/tools/constraints/model/budget; legacy named roles are compatibility presets. ' +
    (backgroundEnabled
      ? 'execution "foreground" (explorer and librarian only) waits for the child and returns its result in this call: use it when you need the result before your next step. "background" returns a running handle immediately and a later completion notification: use it for long or parallel independent work. '
      : 'This session uses foreground execution and returns the structured result in this turn. ') +
    'The subagent runs in its own context and returns only a summary, preserving your context.\n\n' +
    '## When to delegate\n' +
    'Do the work yourself by default. Investigating, implementing, testing and adjusting form one loop: a test result can change the diagnosis, so keep that loop in one agent instead of splitting it across roles. ' +
    "Delegate a unit only when it separates cleanly: it can start without another unit's result, it returns something useful on its own, and you can judge it against the same criteria as any sibling run. " +
    'Give parallel runs one shared starting point, the same requirements and assumptions, or their reports cannot be compared. ' +
    'Use a fresh reviewer when an independent judgment is worth the extra run.\n\n' +
    "You keep ownership of the outcome. A subagent's report is a claim, not a result: check its important claims against the evidence, resolve disagreements between runs yourself, and finish the work. A reviewer's approval is a separate check, not a guarantee.\n\n" +
    (backgroundEnabled
      ? 'Background launches return immediately; do not duplicate them or call get_subagent_result until the completion notification arrives.\n\n'
      : 'Independent foreground explorer and librarian calls in the same model response may run in parallel; keep worker calls and dependent tasks serial.\n\n') +
    '## Task Requirements\n' +
    'Give the task one clear objective, one ownership boundary, and one concrete done condition. Include the task-specific scope, non-discoverable parent findings or decisions, constraints, deliverable or acceptance criteria, and validation when applicable. ' +
    'Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or skills catalog. ' +
    'The subagent does not see your conversation or reasoning. ' +
    "For explorer, request concrete evidence to collect for a bounded question and choose breadth or depth, never both: map one defined surface shallowly or trace one narrow seam thoroughly. Do not ask explorer to diagnose, recommend a fix, choose an approach, or own the user's complete investigation, review, diagnosis, or planning deliverable. " +
    'For worker, assign one cohesive implementation unit. For mentor, ask one decision or challenge question. ' +
    'For reviewer, describe the artifact to review (diff range, files, plan), give the original requirement as the review criteria, and name concrete scenarios to check. Do not present your own reasoning about the change as the requirement; if the reviewer needs it, label it separately. It gathers evidence only through explorers. ' +
    'For librarian, assign one history question to answer from memory and prior sessions, or one memory-maintenance topic boundary.\n\n' +
    'For isolated worker edits, create a git worktree under the workspace root first ' +
    '(`git worktree add .worktrees/<slug> -b <slug>`), then pass `worktree` as that directory basename or branch name. ' +
    '`worktree` pins the child into that existing tree without re-rooting this session; generic writable agents may use it too.\n\n' +
    (backgroundEnabled
      ? 'A background status of "running" means launch succeeded: end the turn and wait for the completion notification.'
      : 'Foreground returns a summary with status (completed, failed, cancelled, or interrupted), any final text, a list of tools used, and files changed.')
  );
}
