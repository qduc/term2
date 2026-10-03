import { it, expect } from 'vitest';
import { MaxTurnsExceededError } from '../agent-runtime/application-run-loop.js';
import {
  buildTurnBudgetExhaustedFinalText,
  extractMaxTurnsLimit,
  formatSubagentResult,
  isAbortLike,
  isMaxTurnsExceededError,
} from './utils.js';

it.each([
  'Unable to read /repo/cancel/config.json',
  'Unable to read /repo/abort/config.json',
  'Provider does not support cancellation metadata',
  'Invalid abort option in tool configuration',
  'Tool returned the text "operation aborted"',
])('isAbortLike treats diagnostic content as failure: %s', (message) => {
  expect(isAbortLike(message, new Error(message))).toBe(false);
  expect(isAbortLike(message)).toBe(false);
});

it.each([{ name: 'AbortError' }, { code: 'ERR_ABORTED' }, { code: 'ABORT_ERR' }, { kind: 'aborted' }])(
  'isAbortLike recognizes cancellation identity %j with neutral diagnostic text',
  (identity) => {
    expect(isAbortLike('Stopped', Object.assign(new Error('Stopped'), identity))).toBe(true);
  },
);

it.each([null, undefined, {}, 'cancelled', { name: 'Error', code: 'OTHER', kind: 'runtime_error' }])(
  'isAbortLike rejects values without cancellation identity: %j',
  (error) => {
    expect(isAbortLike(undefined, error)).toBe(false);
  },
);

it('formatSubagentResult includes worktree path when the worker was pinned', () => {
  const text = formatSubagentResult({
    agentId: 'a1',
    role: 'worker',
    status: 'completed',
    finalText: 'done',
    filesChanged: ['src/a.ts'],
    toolsUsed: [],
    worktreePath: '/repo/.worktrees/feature',
  });
  expect(text).toContain('Status: completed');
  expect(text).toContain('Worktree: /repo/.worktrees/feature');
  expect(text).toContain('done');
});

it('formatSubagentResult does not turn unknown validation evidence into success', () => {
  const text = formatSubagentResult({
    agentId: 'a1',
    role: 'worker',
    status: 'cancelled',
    finalText: '',
    filesChanged: [],
    toolsUsed: [],
    validation: {
      command: 'pnpm test',
      exitStatus: 'unknown',
      outputExcerpt: 'cancelled\nInterrupted: the command was cancelled before completing.',
    },
  });

  expect(text).toContain('Validation: pnpm test → exit unknown');
  expect(text).not.toContain('Validation: pnpm test → exit 0');
});

it('isMaxTurnsExceededError recognizes the run-loop budget class and its message', () => {
  expect(isMaxTurnsExceededError(new MaxTurnsExceededError(12))).toBe(true);
  expect(isMaxTurnsExceededError(new Error('Max turns (12) exceeded'))).toBe(true);
  expect(isMaxTurnsExceededError('Max turns (3) exceeded')).toBe(true);
  expect(isMaxTurnsExceededError(new Error('provider failed'))).toBe(false);
});

it('extractMaxTurnsLimit reads the budget from the error', () => {
  expect(extractMaxTurnsLimit(new MaxTurnsExceededError(20))).toBe(20);
  expect(extractMaxTurnsLimit(new Error('Max turns (7) exceeded'))).toBe(7);
  expect(extractMaxTurnsLimit(new Error('provider failed'))).toBeUndefined();
});

it('buildTurnBudgetExhaustedFinalText preserves partial narrative under a budget-stop header', () => {
  expect(buildTurnBudgetExhaustedFinalText({ maxTurns: 5, partialText: 'Found three call sites.' })).toBe(
    [
      'Turn budget exhausted (5). Stopping with partial results — this is a budget stop, not a task failure. Report what completed and what remains.',
      '',
      'Found three call sites.',
    ].join('\n'),
  );
  expect(buildTurnBudgetExhaustedFinalText({ maxTurns: 3 })).toContain('Turn budget exhausted (3)');
  expect(buildTurnBudgetExhaustedFinalText({ maxTurns: 3 })).not.toContain('\n\n');
});
