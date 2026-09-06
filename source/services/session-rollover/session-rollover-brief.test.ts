import { describe, expect, it } from 'vitest';
import { composeSessionRolloverBrief } from './session-rollover-brief.js';

describe('composeSessionRolloverBrief', () => {
  it('carries the source session, reason, handoff, retrieval discipline, and next-step instruction', () => {
    const brief = composeSessionRolloverBrief({
      previousSessionId: 'session-old',
      successorSessionId: 'session-new',
      request: {
        brief: 'Completed the parser. Open: run the black-box gate. State: docs/plans/parser.md.',
        reason: 'task_boundary',
      },
    });

    expect(brief).toContain('Previous session: `session-old`');
    expect(brief).toContain('Outcome: completed into successor session `session-new`');
    expect(brief).toContain('Reason: task boundary');
    expect(brief).toContain('Completed the parser. Open: run the black-box gate. State: docs/plans/parser.md.');
    expect(brief).toContain('session_read({ id: "previous"');
    expect(brief).toContain('Use `session_search` only when');
    expect(brief).toContain('Do not replay the entire previous transcript');
    expect(brief).toContain('Continue from the next open step');
    expect(brief).toContain('session-owned');
    expect(brief).toContain('durable artifacts');
  });

  it('labels an unspecified reason without inventing one', () => {
    expect(
      composeSessionRolloverBrief({
        previousSessionId: 'session-old',
        successorSessionId: 'session-new',
        request: { brief: 'Continue.' },
      }),
    ).toContain('Reason: not specified');
  });

  it('includes the harness-owned live-work inventory rather than relying on the handoff text', () => {
    const brief = composeSessionRolloverBrief({
      previousSessionId: 'session-old',
      successorSessionId: 'session-new',
      request: { brief: 'Continue.' },
      taskInventory: [
        { kind: 'shell', id: 'job-1', status: 'running' },
        { kind: 'subagent', id: 'run-1', status: 'waiting_for_answer' },
      ],
    });

    expect(brief).toContain('## Harness-observed live work at cutover');
    expect(brief).toContain('- shell `job-1` status: running');
    expect(brief).toContain('- subagent `run-1` status: waiting_for_answer');
  });
});
