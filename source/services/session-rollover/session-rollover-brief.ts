import type { SessionRolloverRequest } from '../../contracts/session-rollover.js';

const reasonLabel = (reason: SessionRolloverRequest['reason']): string => {
  if (reason === 'context_pressure') return 'context pressure';
  if (reason === 'task_boundary') return 'task boundary';
  return 'not specified';
};

export type SessionRolloverTaskInventoryEntry = {
  kind: 'shell' | 'subagent';
  id: string;
  status: string;
};

export function composeSessionRolloverBrief({
  previousSessionId,
  successorSessionId,
  request,
  taskInventory = [],
}: {
  previousSessionId: string;
  successorSessionId: string;
  request: SessionRolloverRequest;
  taskInventory?: readonly SessionRolloverTaskInventoryEntry[];
}): string {
  const inventory =
    taskInventory.length === 0
      ? ['- none observed at cutover']
      : taskInventory.map((task) => `- ${task.kind} \`${task.id}\` status: ${task.status}`);
  return [
    '# Continuation briefing',
    '',
    `Previous session: \`${previousSessionId}\``,
    `Outcome: completed into successor session \`${successorSessionId}\``,
    `Reason: ${reasonLabel(request.reason)}`,
    '',
    '## Harness-observed live work at cutover',
    '',
    ...inventory,
    '',
    '## Handoff from the previous session',
    '',
    request.brief,
    '',
    '## Continuation protocol',
    '',
    '- Treat a self-contained handoff as the primary authority. If it explicitly names one canonical durable artifact, treat the handoff as a delta and that artifact as authoritative; do not duplicate the full state in both places.',
    '- If predecessor detail is missing, read `session_read({ id: "previous", ... })` directly with bounded limits.',
    '- Use `session_search` only when the relevant session or location is unknown.',
    '- Do not replay the entire previous transcript.',
    '- Live job and subagent handles remain session-owned and are retained across this rollover; inspect or control them through the background-task tools when needed. Use durable artifacts, paths, and commits for completed results rather than copying transient output into the handoff.',
    '- Continue from the next open step rather than redoing completed work.',
  ].join('\n');
}
