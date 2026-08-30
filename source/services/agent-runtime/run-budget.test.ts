import { describe, expect, it } from 'vitest';
import { clampRunBudgetPolicy, RunBudget } from './run-budget.js';
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
  escalation: 'pause',
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

  it('discounts cache reads to a tenth of a fresh token', () => {
    // A cache read is roughly an order of magnitude cheaper than fresh input, so
    // charging it at face value made the cheapest sessions exhaust the envelope
    // fastest.
    const budget = new RunBudget(policy, 0);

    budget.evaluate({
      now: 10,
      turns: 1,
      costRecords: [
        cost({
          requestId: 'cached',
          usage: { total_tokens: 1000, prompt_tokens: 900, completion_tokens: 100, cache_read_tokens: 800 },
        }),
      ],
    });

    // 1000 total - 800 cache reads charged at 1/10 => 1000 - 720
    expect(budget.snapshot(10).unpricedTokens).toBe(280);
  });

  it('exempts subscription providers from the unpriced-token budget', () => {
    // Grok and Codex are unpriced because no per-token rate applies at all, so
    // their tokens are not a spend proxy for anything.
    const budget = new RunBudget(policy, 0);

    budget.evaluate({
      now: 10,
      turns: 1,
      costRecords: [
        { ...cost({ requestId: 'grok', usage: { total_tokens: 900 } }), provider: 'grok' },
        { ...cost({ requestId: 'byok', usage: { total_tokens: 100 } }), provider: 'some-gateway' },
      ],
    });

    expect(budget.snapshot(10).unpricedTokens).toBe(100);
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

  it('keeps telling the run about a repetition while telling the parent exactly once', () => {
    const budget = new RunBudget(policy, 0);
    const repeat = () => budget.observeToolCall({ name: 'shell', argumentsText: '{"command":"pnpm test"}' });

    repeat();
    repeat();
    // Third identical call: the parent hears once...
    expect(repeat()).toEqual(expect.objectContaining({ type: 'tool_stall', count: 3 }));
    expect(budget.takeStallEvidence()).toEqual(expect.objectContaining({ count: 3 }));
    expect(budget.takeStallEvidence()).toBeUndefined();

    repeat();
    repeat();
    // ...and stays quiet on the sixth, but the run itself is told again.
    expect(repeat()).toBeUndefined();
    expect(budget.takeStallEvidence()).toEqual(expect.objectContaining({ count: 6 }));
  });

  it('caps parent grants but lets a human grant past the cap', () => {
    const budget = new RunBudget(policy, 0);

    expect(budget.grantExtension('parent')).toEqual({ granted: true, extensionsGranted: 1 });
    expect(budget.grantExtension('parent')).toEqual({ granted: true, extensionsGranted: 2 });
    expect(budget.grantExtension('parent')).toEqual({ granted: false, extensionsGranted: 2 });
    expect(budget.grantExtension('human')).toEqual({ granted: true, extensionsGranted: 3 });
    // A human grant does not restore parent room, which is spent for this run.
    expect(budget.grantExtension('parent')).toEqual({ granted: false, extensionsGranted: 3 });
  });

  it('reports its remaining envelope so a child can be clamped to what is left', () => {
    const budget = new RunBudget(policy, 0);
    budget.evaluate({ now: 400, turns: 2, costRecords: [cost({ requestId: 'a', usdMicros: 60 })] });

    const remaining = budget.remainingPolicy(400);

    expect(remaining).toMatchObject({
      maxUsdMicros: 40,
      maxActiveTimeMs: 600,
      turnBackstop: 3,
      // Thresholds describe what counts as alarming, not how much room is left.
      warningHeadroomUsdMicros: policy.warningHeadroomUsdMicros,
    });
  });

  it('never reports a negative remainder once a dimension is overspent', () => {
    const budget = new RunBudget(policy, 0);
    budget.evaluate({ now: 5_000, turns: 99, costRecords: [cost({ requestId: 'a', usdMicros: 500 })] });

    expect(budget.remainingPolicy(5_000)).toMatchObject({
      maxUsdMicros: 0,
      maxActiveTimeMs: 0,
      turnBackstop: 0,
    });
  });

  it('emits no budget or stall events when escalation is disabled', () => {
    const budget = new RunBudget({ ...policy, escalation: 'disabled' }, 0);
    const events = budget.evaluate({
      now: 5_000,
      turns: 99,
      costRecords: [cost({ requestId: 'a', usdMicros: 500 })],
    });
    expect(events).toEqual([]);

    const stall = budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' });
    expect(stall).toBeUndefined();
    expect(budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' })).toBeUndefined();
    expect(budget.observeToolCall({ name: 'read_file', argumentsText: '{"path":"a"}' })).toBeUndefined();
  });
});

describe('clampRunBudgetPolicy', () => {
  it('returns the child envelope unchanged at the root, where there is no parent', () => {
    expect(clampRunBudgetPolicy(policy)).toEqual(policy);
  });

  it('holds a child to the tighter of the two envelopes on every containment dimension', () => {
    const parent = { ...policy, maxUsdMicros: 40, maxUnpricedTokens: 5_000, turnBackstop: 3, maxParentExtensions: 1 };

    const clamped = clampRunBudgetPolicy(policy, parent);

    expect(clamped).toMatchObject({
      maxUsdMicros: 40,
      // The child is already tighter here, so the parent must not loosen it.
      maxUnpricedTokens: policy.maxUnpricedTokens,
      turnBackstop: 3,
      maxParentExtensions: 1,
    });
  });
});
