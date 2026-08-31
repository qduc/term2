import { describe, expect, it } from 'vitest';
import { composeSessionRolloverBrief } from './session-rollover-brief.js';

describe('composeSessionRolloverBrief', () => {
  it('carries the source session, reason, handoff, retrieval discipline, and next-step instruction', () => {
    const brief = composeSessionRolloverBrief({
      previousSessionId: 'session-old',
      request: {
        brief: 'Completed the parser. Open: run the black-box gate. State: docs/plans/parser.md.',
        reason: 'task_boundary',
      },
    });

    expect(brief).toContain('Previous session: `session-old`');
    expect(brief).toContain('Reason: task boundary');
    expect(brief).toContain('Completed the parser. Open: run the black-box gate. State: docs/plans/parser.md.');
    expect(brief).toContain('session_search');
    expect(brief).toContain('session_read');
    expect(brief).toContain('Do not replay the entire previous transcript');
    expect(brief).toContain('Continue from the next open step');
  });

  it('labels an unspecified reason without inventing one', () => {
    expect(
      composeSessionRolloverBrief({ previousSessionId: 'session-old', request: { brief: 'Continue.' } }),
    ).toContain('Reason: not specified');
  });
});
