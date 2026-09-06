import type { SessionRolloverRequest } from '../../contracts/session-rollover.js';

const reasonLabel = (reason: SessionRolloverRequest['reason']): string => {
  if (reason === 'context_pressure') return 'context pressure';
  if (reason === 'task_boundary') return 'task boundary';
  return 'not specified';
};

export function composeSessionRolloverBrief({
  previousSessionId,
  successorSessionId,
  request,
}: {
  previousSessionId: string;
  successorSessionId: string;
  request: SessionRolloverRequest;
}): string {
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
    '## Continuation protocol',
    '',
    '- Treat a self-contained handoff as the primary authority. If it explicitly names one canonical durable artifact, treat the handoff as a delta and that artifact as authoritative; do not duplicate the full state in both places.',
    '- If predecessor detail is missing, read `session_read({ id: "previous", ... })` directly with bounded limits.',
    '- Use `session_search` only when the relevant session or location is unknown.',
    '- Do not replay the entire previous transcript.',
    '- Old job and subagent handles are session-owned and may not be queryable here. Use durable artifacts, paths, and commits to verify their results; a missing handle is not evidence that completed work failed.',
    '- Continue from the next open step rather than redoing completed work.',
  ].join('\n');
}
