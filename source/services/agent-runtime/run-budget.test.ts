import { describe, expect, it } from 'vitest';
import { RunBudget } from './run-budget.js';
import type { ModelRequestCost } from '../cost/model-cost.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';

const policy = {
  maxUsdMicros: 100,
  maxUnpricedTokens: 1_000,
  maxActiveTimeMs: 1_000,
  warningHeadroomUsdMicros: 30,
  warningHeadroomUnpricedTokens: 300,
  warningHeadroomActiveTimeMs: 300,
  softHeadroomUsdMicros: 10,
  softHeadroomUnpricedTokens: 100,
  softHeadroomActiveTimeMs: 100,
  turnBackstop: 5,
  extensionPercent: 50,
  maxParentExtensions: 2,
  identicalToolCallThreshold: 3,
} as const;

const cost = (input: { requestId: string; usdMicros?: number; usage?: NormalizedUsage }): ModelRequestCost => ({
  provider: 'test',
  model: 'test',
  serviceTier: 'standard',
  outcome: 'completed',
  ...input,
});

describe('RunBudget', () => {
  it('accounts USD only for priced requests and tokens only for unpriced requests', () => {
    const budget = new RunBudget(policy, 0);

    const events = budget.evaluate({
      now: 10,
      turns: 1,
      costRecords: [
        cost({ requestId: 'priced', usdMicros: 80, usage: { total_tokens: 900 } }),
        cost({ requestId: 'unpriced', usage: { total_tokens: 750 } }),
      ],
    });

    expect(budget.snapshot(10)).toMatchObject({ pricedUsdMicros: 80, unpricedTokens: 750, activeTimeMs: 10 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'budget_stage',
        stage: 'warning',
        evidence: expect.objectContaining({ dimension: 'usd' }),
      }),
    );
  });

  it('excludes approval-paused wall time', () => {
    const budget = new RunBudget(policy, 100);
    budget.pause(250);
    budget.resume(10_250);
    budget.evaluate({ now: 10_300, turns: 0, costRecords: [] });

    expect(budget.snapshot(10_300).activeTimeMs).toBe(200);
  });

  it('latches stages and grants only finite extensions', () => {
    const budget = new RunBudget(policy, 0);
    const first = budget.evaluate({ now: 0, turns: 1, costRecords: [cost({ requestId: 'one', usdMicros: 100 })] });

    expect(first.filter((event) => event.type === 'budget_stage').map((event) => event.stage)).toEqual([
      'soft',
      'warning',
      'critical',
    ]);
    expect(budget.grantExtension()).toEqual({ granted: true, extensionsGranted: 1 });
    expect(budget.grantExtension()).toEqual({ granted: true, extensionsGranted: 2 });
    expect(budget.grantExtension()).toEqual({ granted: false, extensionsGranted: 2 });
    expect(budget.evaluate({ now: 0, turns: 1, costRecords: [cost({ requestId: 'one', usdMicros: 100 })] })).toEqual(
      [],
    );
  });

  it('re-arms critical for each finite extension instead of silently continuing past the larger envelope', () => {
    const budget = new RunBudget(policy, 0);
    budget.evaluate({ now: 0, turns: 1, costRecords: [cost({ requestId: 'one', usdMicros: 100 })] });
    expect(budget.grantExtension()).toEqual({ granted: true, extensionsGranted: 1 });

    expect(
      budget.evaluate({ now: 0, turns: 1, costRecords: [cost({ requestId: 'two', usdMicros: 150 })] }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'budget_stage',
        stage: 'critical',
        evidence: expect.objectContaining({ used: 150, limit: 150 }),
      }),
    );
  });

  it('reports byte-identical non-mutating calls once and resets the sequence after a mutating call', () => {
    const budget = new RunBudget(policy, 0);

    expect(budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' })).toBeUndefined();
    expect(budget.observeToolCall({ name: 'grep', argumentsText: '{"pattern":"a"}' })).toBeUndefined();
    expect(budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' })).toBeUndefined();
    expect(budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' })).toEqual(
      expect.objectContaining({ type: 'tool_stall', count: 3 }),
    );
    expect(budget.observeToolCall({ name: 'apply_patch', argumentsText: '{}', effect: 'mutating' })).toBeUndefined();
    expect(budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' })).toBeUndefined();
  });
});
