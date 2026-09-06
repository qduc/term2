import type { SessionRolloverRequest } from '../../contracts/session-rollover.js';

export type InheritedRolloverTask = {
  kind: 'shell' | 'subagent';
  id: string;
  status: string;
  startedAt: number;
  command?: string;
  role?: string;
  task?: string;
  name?: string;
};

const reasonLabel = (reason: SessionRolloverRequest['reason']): string => {
  if (reason === 'context_pressure') return 'context pressure';
  if (reason === 'task_boundary') return 'task boundary';
  return 'not specified';
};

export function composeSessionRolloverBrief({
  previousSessionId,
  successorSessionId,
  request,
  inheritedTasks = [],
}: {
  previousSessionId: string;
  successorSessionId: string;
  request: SessionRolloverRequest;
  inheritedTasks?: readonly InheritedRolloverTask[];
}): string {
  const inventory = inheritedTasks.length
    ? [
        '## Inherited live-task inventory',
        '',
        'These handles were transferred without cancellation. Use the exact IDs with the background-task controls; completion notifications remain owed through the normal notification lane.',
        '',
        '```json',
        JSON.stringify(inheritedTasks, null, 2),
        '```',
        '',
      ]
    : [];
  return [
    '# Continuation briefing',
    '',
    `Previous session: \`${previousSessionId}\``,
    `Outcome: completed into successor session \`${successorSessionId}\``,
    `Reason: ${reasonLabel(request.reason)}`,
    '',
    '## Handoff from the previous session',
    '',
    request.brief,
    '',
    ...inventory,
    '## Continuation protocol',
    '',
    '- Treat a self-contained handoff as the primary authority. If it explicitly names one canonical durable artifact, treat the handoff as a delta and that artifact as authoritative; do not duplicate the full state in both places.',
    '- If predecessor detail is missing, read `session_read({ id: "previous", ... })` directly with bounded limits.',
    '- Use `session_search` only when the relevant session or location is unknown.',
    '- Do not replay the entire previous transcript.',
    '- Inherited live-task handles above remain controllable in this successor; use their exact IDs and wait for the normal completion notification instead of relaunching them. These session-owned tasks may also be checked against durable artifacts.',
    '- Continue from the next open step rather than redoing completed work.',
  ].join('\n');
}
