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

  it('omits completed, failed, and cancelled tasks, preserving only active running and waiting states', () => {
    const brief = composeSessionRolloverBrief({
      previousSessionId: 'session-old',
      successorSessionId: 'session-new',
      request: { brief: 'Continue.' },
      taskInventory: [
        { kind: 'shell', id: 'job-running', status: 'running' },
        { kind: 'shell', id: 'job-cancelling', status: 'cancelling' },
        { kind: 'shell', id: 'job-done', status: 'completed' },
        { kind: 'shell', id: 'job-err', status: 'failed' },
        { kind: 'shell', id: 'job-stopped', status: 'cancelled' },
        { kind: 'shell', id: 'job-timeout', status: 'timed_out' },
        { kind: 'subagent', id: 'sub-running', status: 'running' },
        { kind: 'subagent', id: 'sub-approval', status: 'awaiting_approval' },
        { kind: 'subagent', id: 'sub-answer', status: 'waiting_for_answer' },
        { kind: 'subagent', id: 'sub-cancelling', status: 'cancelling' },
        { kind: 'subagent', id: 'sub-done', status: 'completed' },
        { kind: 'subagent', id: 'sub-err', status: 'failed' },
        { kind: 'subagent', id: 'sub-stopped', status: 'cancelled' },
        { kind: 'subagent', id: 'sub-interrupted', status: 'interrupted' },
        { kind: 'subagent', id: 'sub-missing', status: 'not_found' },
      ],
    });

    expect(brief).toContain('- shell `job-running` status: running');
    expect(brief).toContain('- shell `job-cancelling` status: cancelling');
    expect(brief).toContain('- subagent `sub-running` status: running');
    expect(brief).toContain('- subagent `sub-approval` status: awaiting_approval');
    expect(brief).toContain('- subagent `sub-answer` status: waiting_for_answer');
    expect(brief).toContain('- subagent `sub-cancelling` status: cancelling');

    expect(brief).not.toContain('job-done');
    expect(brief).not.toContain('job-err');
    expect(brief).not.toContain('job-stopped');
    expect(brief).not.toContain('job-timeout');
    expect(brief).not.toContain('sub-done');
    expect(brief).not.toContain('sub-err');
    expect(brief).not.toContain('sub-stopped');
    expect(brief).not.toContain('sub-interrupted');
    expect(brief).not.toContain('sub-missing');
  });

  it('renders none observed at cutover when all inventory entries are terminal', () => {
    const brief = composeSessionRolloverBrief({
      previousSessionId: 'session-old',
      successorSessionId: 'session-new',
      request: { brief: 'Continue.' },
      taskInventory: [
        { kind: 'shell', id: 'job-done', status: 'completed' },
        { kind: 'shell', id: 'job-failed', status: 'failed' },
        { kind: 'shell', id: 'job-timeout', status: 'timed_out' },
        { kind: 'subagent', id: 'sub-done', status: 'completed' },
        { kind: 'subagent', id: 'sub-cancelled', status: 'cancelled' },
      ],
    });

    expect(brief).toContain('## Harness-observed live work at cutover\n\n- none observed at cutover');
    expect(brief).not.toContain('job-done');
    expect(brief).not.toContain('job-failed');
    expect(brief).not.toContain('job-timeout');
    expect(brief).not.toContain('sub-done');
    expect(brief).not.toContain('sub-cancelled');
  });
});
