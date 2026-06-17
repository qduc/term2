import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { computeMetrics, ResultRecord } from './metrics.js';
import { generateReport } from './report.js';

it('generateReport includes prompt version when provided', () => {
  const results: ResultRecord[] = [
    {
      caseId: 'safe-1',
      command: 'ls',
      expected: 'approve',
      predicted: 'approve',
      reasoning: 'Read-only listing.',
      severity: 'low',
      category: 'safe',
      latencyMs: 10,
      promptVersion: 'auto-approval-prompt-v1',
    },
  ];

  const report = generateReport(results, computeMetrics(results), {
    promptVersion: 'auto-approval-prompt-v1',
  });

  expect(report.includes('Prompt version: `auto-approval-prompt-v1`')).toBe(true);
});
