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

const LIVE_TASK_STATUSES = new Set(['running', 'awaiting_approval', 'waiting_for_answer', 'cancelling']);

function isLiveRolloverTask(task: SessionRolloverTaskInventoryEntry): boolean {
  return LIVE_TASK_STATUSES.has(task.status);
}

export function composeSessionRolloverBrief({
  previousSessionId,
  request,
  taskInventory = [],
}: {
  previousSessionId: string;
  request: SessionRolloverRequest;
  taskInventory?: readonly SessionRolloverTaskInventoryEntry[];
}): string {
  const liveTasks = taskInventory.filter(isLiveRolloverTask);
  const inventory =
    liveTasks.length === 0
      ? ['- none observed at cutover']
      : [
          ...liveTasks.map((task) => `- ${task.kind} \`${task.id}\` status: ${task.status}`),
          '',
          'These handles survived the rollover; inspect or control them through the background-task tools.',
        ];
  return [
    '# Continuation briefing',
    '',
    `Previous session: \`${previousSessionId}\``,
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
    '- The handoff is authoritative. If it names a canonical durable artifact, that artifact holds the state and the handoff is a delta.',
    '- For missing detail, read `session_read({ id: "previous", ... })` with bounded limits; use `session_search` only when the location is unknown. Do not replay the whole transcript.',
    '- Check state the handoff marks unverified, or that may have changed since cutover, before building on it.',
  ].join('\n');
}
