import { describe, it, expect } from 'vitest';
import { resolveModelPolicy } from './model-resolver.js';
import type { ISettingsService } from '../service-interfaces.js';
import type { ModelPolicy } from './types.js';

function settings(values: Record<string, unknown> = {}): ISettingsService {
  const store: Record<string, unknown> = {
    'agent.provider': 'openai',
    'agent.model': 'gpt-4o',
    ...values,
  };
  return {
    get: (key: any) => store[key] as any,
    getDynamic: (key: string) => store[key],
    set: () => {},
    setDynamic: () => {},
    setPersistent: () => {},
    setPersistentDynamic: () => {},
  };
}

describe('resolveModelPolicy', () => {
  // ── Exact ──────────────────────────────────────────────
  it('resolves exact {provider, model} directly', () => {
    const policy: ModelPolicy = { provider: 'anthropic', model: 'claude-sonnet' };
    const result = resolveModelPolicy(policy, settings());
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet' });
  });

  it('resolves ancillary tiers independently from the main agent model', () => {
    const s = settings({
      'agent.model': 'main-model',
      'agent.provider': 'main-provider',
      'agent.smartModel': 'smart-model',
      'agent.smartProvider': 'smart-provider',
      'agent.balancedModel': 'balanced-model',
      'agent.balancedProvider': 'balanced-provider',
      'agent.cheapModel': 'cheap-model',
      'agent.cheapProvider': 'cheap-provider',
      'agent.choreModel': 'chore-model',
      'agent.choreProvider': 'chore-provider',
    });

    expect(resolveModelPolicy('capable', s)).toEqual({ provider: 'smart-provider', model: 'smart-model' });
    expect(resolveModelPolicy('balanced', s)).toEqual({ provider: 'balanced-provider', model: 'balanced-model' });
    expect(resolveModelPolicy('efficient', s)).toEqual({ provider: 'cheap-provider', model: 'cheap-model' });
  });

  // ── Named tiers ────────────────────────────────────────
  it('resolves "balanced" from agent.model setting', () => {
    const s = settings({ 'agent.model': 'gpt-4o' });
    expect(resolveModelPolicy('balanced', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('resolves "efficient" from agent.cheapModel setting', () => {
    const s = settings({
      'agent.cheapModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    expect(resolveModelPolicy('efficient', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('resolves "capable" from agent.smartModel setting', () => {
    const s = settings({
      'agent.smartModel': 'gpt-4o',
      'agent.provider': 'openai',
    });
    expect(resolveModelPolicy('capable', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('falls back to agent.model for efficient/capable when not configured', () => {
    const s = settings({
      'agent.model': 'gpt-4o',
      'agent.provider': 'openai',
    });
    // No agent.cheapModel set → falls back to agent.model
    expect(resolveModelPolicy('efficient', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  // ── Legacy keys ignored (D1 deprecation-window closure) ──
  // settings-legacy-debt D1: legacy role keys stay parse-accepted and
  // migration-mapped, but the resolver must read tier keys only.
  it('ignores legacy efficient-tier keys instead of falling back through them', () => {
    const s = settings({
      'agent.efficientModel': 'legacy-efficient',
      'agent.subagentExplorerModel': 'legacy-explorer',
      'agent.model': 'main-model',
    });
    expect(resolveModelPolicy('efficient', s).model).toBe('main-model');
  });

  it('ignores legacy capable-tier keys instead of falling back through them', () => {
    const s = settings({
      'agent.capableModel': 'legacy-capable',
      'agent.mentorModel': 'legacy-mentor',
      'agent.model': 'main-model',
    });
    expect(resolveModelPolicy('capable', s).model).toBe('main-model');
  });

  it('prefers tier keys over any legacy keys', () => {
    const s = settings({
      'agent.cheapModel': 'cheap-model',
      'agent.efficientModel': 'legacy-efficient',
      'agent.subagentExplorerModel': 'legacy-explorer',
      'agent.model': 'main-model',
    });
    expect(resolveModelPolicy('efficient', s).model).toBe('cheap-model');
  });

  it('falls back from unset cheap tier settings to the terminal model fallback', () => {
    const s = settings({
      'agent.cheapModel': undefined,
      'agent.model': undefined,
    });
    expect(resolveModelPolicy('efficient', s).model).toBe('gpt-4o');
  });

  it('falls back from unset smart tier settings to the terminal model fallback', () => {
    const s = settings({
      'agent.smartModel': undefined,
      'agent.model': undefined,
    });
    expect(resolveModelPolicy('capable', s).model).toBe('gpt-4o');
  });

  // ── Relative tier (no parent) ─────────────────────────
  it('rejects relative tier when no parent policy is provided', () => {
    const s = settings();
    expect(() => resolveModelPolicy({ tier: 'lower' }, s)).toThrow(/relative model policy requires a parent/i);
  });

  // ── Relative tier with parent ─────────────────────────
  it('resolves relative "lower" tier against parent exact model', () => {
    const s = settings({
      'agent.cheapModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('prefers cheapModel for relative lower tier over agent.model', () => {
    const s = settings({
      'agent.cheapModel': 'cheap-model',
      'agent.model': 'main-model',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'parent-model' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent).model).toBe('cheap-model');
  });

  it('ignores legacy keys for relative lower tier and falls back to agent.model', () => {
    const s = settings({
      'agent.efficientModel': 'legacy-efficient',
      'agent.subagentExplorerModel': 'legacy-explorer',
      'agent.model': 'main-model',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'parent-model' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent).model).toBe('main-model');
  });

  it('falls back to the parent model for relative lower tier when all settings are unset', () => {
    const s = settings({
      'agent.cheapModel': undefined,
      'agent.model': undefined,
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'parent-model' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent).model).toBe('parent-model');
  });

  it('resolves relative "same" tier against parent exact model', () => {
    const s = settings();
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'same' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('resolves relative "higher" tier against parent exact model', () => {
    const s = settings({
      'agent.smartModel': 'gpt-4.1',
      'agent.provider': 'openai',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'higher' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
  });

  it('ignores legacy keys for relative higher tier and falls back to agent.model', () => {
    const s = settings({
      'agent.capableModel': 'legacy-capable',
      'agent.mentorModel': 'legacy-mentor',
      'agent.model': 'main-model',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'parent-model' };
    expect(resolveModelPolicy({ tier: 'higher' }, s, parent).model).toBe('main-model');
  });

  it('falls back to the parent model for relative higher tier when all settings are unset', () => {
    const s = settings({
      'agent.smartModel': undefined,
      'agent.model': undefined,
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'parent-model' };
    expect(resolveModelPolicy({ tier: 'higher' }, s, parent).model).toBe('parent-model');
  });

  it('resolves relative "lower" with reasoning flag from settings', () => {
    const s = settings({
      'agent.reasoningModel': 'o1-mini',
      'agent.provider': 'openai',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'lower', reasoning: 'high' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'o1-mini',
    });
  });

  it('resolves per-effort reasoning model from dedicated setting', () => {
    const s = settings({
      'agent.reasoning.low': 'o1-mini',
      'agent.reasoning.high': 'o1-pro',
      'agent.provider': 'openai',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'lower', reasoning: 'low' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'o1-mini',
    });
    expect(resolveModelPolicy({ tier: 'higher', reasoning: 'high' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'o1-pro',
    });
  });

  it('preserves parent provider when resolving relative tier', () => {
    const s = settings({
      'agent.cheapModel': 'claude-haiku',
    });
    const parent: ModelPolicy = { provider: 'anthropic', model: 'claude-sonnet' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku',
    });
  });
});
