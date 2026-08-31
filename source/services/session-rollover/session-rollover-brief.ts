import type { SessionRolloverRequest } from '../../contracts/session-rollover.js';

const reasonLabel = (reason: SessionRolloverRequest['reason']): string => {
  if (reason === 'context_pressure') return 'context pressure';
  if (reason === 'task_boundary') return 'task boundary';
  return 'not specified';
};

export function composeSessionRolloverBrief({
  previousSessionId,
  request,
}: {
  previousSessionId: string;
  request: SessionRolloverRequest;
}): string {
  return [
    '# Continuation briefing',
    '',
    `Previous session: \`${previousSessionId}\``,
    `Reason: ${reasonLabel(request.reason)}`,
    '',
    '## Handoff from the previous session',
    '',
    request.brief,
    '',
    '## Continuation protocol',
    '',
    '- Treat the handoff and its durable-state pointers as the primary source of truth.',
    '- If essential detail is missing, use `session_search` and then a bounded `session_read` against the previous session.',
    '- Do not replay the entire previous transcript.',
    '- Continue from the next open step rather than redoing completed work.',
  ].join('\n');
}
