import { describe, expect, it } from 'vitest';
import { sanitizeSubagentResult } from './conversation-log-writer.js';

const enrichedResult = {
  agentId: 'run-1',
  role: 'worker',
  status: 'completed',
  finalText: 'done',
  filesChanged: ['src/a.ts', 'src/b.ts'],
  toolsUsed: [{ toolName: 'search_replace', count: 2 }],
  diffStat: [
    { path: 'src/a.ts', added: 10, deleted: 3 },
    { path: 'src/b.ts', added: 5, deleted: 0 },
  ],
  validation: {
    command: 'pnpm vitest run',
    exitStatus: 0,
    outputExcerpt: 'Tests passed',
  },
  nestedRunResult: { secret: 'should-be-stripped' },
};

describe('sanitizeSubagentResult back-compat (plan D6)', () => {
  it('preserves diffStat and validation fields', () => {
    const sanitized = sanitizeSubagentResult({ type: 'subagent_completed', result: enrichedResult }) as any;

    const result = sanitized.result;
    expect(result.diffStat).toEqual(enrichedResult.diffStat);
    expect(result.validation).toEqual(enrichedResult.validation);
  });

  it('strips nestedRunResult', () => {
    const sanitized = sanitizeSubagentResult({ type: 'subagent_completed', result: enrichedResult }) as any;

    expect(sanitized.result.nestedRunResult).toBeUndefined();
  });

  it('preserves all existing fields (status, finalText, filesChanged, toolsUsed)', () => {
    const sanitized = sanitizeSubagentResult({ type: 'subagent_completed', result: enrichedResult }) as any;

    const result = sanitized.result;
    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('done');
    expect(result.filesChanged).toEqual(enrichedResult.filesChanged);
    expect(result.toolsUsed).toEqual(enrichedResult.toolsUsed);
  });

  it('handles a result without diffStat or validation (backward compatible)', () => {
    const minimal = {
      type: 'subagent_completed',
      result: {
        agentId: 'run-2',
        role: 'explorer',
        status: 'completed',
        finalText: 'found',
        filesChanged: [],
        toolsUsed: [],
      },
    };
    const sanitized = sanitizeSubagentResult(minimal) as any;
    expect(sanitized.result.diffStat).toBeUndefined();
    expect(sanitized.result.validation).toBeUndefined();
    expect(sanitized.result.status).toBe('completed');
  });
});
