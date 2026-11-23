/**
 * The model-facing `run_subagent` tool description. Under the Bare profile this
 * is the main agent's only delegation guidance, so it carries both when to
 * delegate and how to write the task. It is product behavior.
 */
export function getRunSubagentDescription(backgroundEnabled: boolean): string {
  return (
    'Delegate a bounded task to a subagent (agent_spec for a custom agent, role for a preset); it works in its own context and returns a summary. ' +
    (backgroundEnabled
      ? '"foreground" (explorer, librarian) returns the result now; "background" returns a handle and notifies on completion.\n\n'
      : 'It runs in the foreground and returns its result in this turn.\n\n') +
    'Do the work yourself by default: investigate, implement and test in one loop, since results change the diagnosis. ' +
    'Delegate only units that start independently, stand alone, and can be judged by shared criteria; give parallel runs the same inputs so reports compare. ' +
    'Use a fresh reviewer for an independent check. Reports are claims: verify the key ones, resolve conflicts, and finish the work yourself.\n\n' +
    'The subagent cannot see this conversation. State one objective, ownership boundary and done condition, plus non-discoverable findings, constraints and acceptance criteria; skip the role, tool, environment, AGENTS.md and skills context it already has.\n' +
    '- explorer: evidence for one bounded question, breadth or depth; never diagnosis, recommendations, or your whole deliverable\n' +
    '- worker: one cohesive implementation unit\n' +
    '- mentor: one decision or challenge\n' +
    '- reviewer: the artifact, the original requirement as criteria, concrete scenarios; label your own reasoning separately\n' +
    '- librarian: one history or memory-maintenance question\n\n' +
    'Isolated worker edits: `git worktree add .worktrees/<slug> -b <slug>`, then pass the basename or branch as `worktree`.' +
    (backgroundEnabled
      ? '\n\n"running" means launched: end the turn and wait for the notification; do not relaunch or call get_subagent_result first.'
      : '\n\nIndependent explorer and librarian calls in one response may run in parallel; keep worker and dependent calls serial.')
  );
}
