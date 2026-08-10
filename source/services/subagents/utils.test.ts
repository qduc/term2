import { it, expect } from 'vitest';
import { formatSubagentResult } from './utils.js';

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
