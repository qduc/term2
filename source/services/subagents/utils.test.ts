import { it, expect } from 'vitest';
import { MaxTurnsExceededError } from '../agent-runtime/application-run-loop.js';
import {
  buildTurnBudgetExhaustedFinalText,
  extractMaxTurnsLimit,
  formatSubagentResult,
  isMaxTurnsExceededError,
} from './utils.js';

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
