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
    get: <T>(key: string) => store[key] as T,
    set: () => {},
  };
}

describe('resolveModelPolicy', () => {
  // ── Exact ──────────────────────────────────────────────
  it('resolves exact {provider, model} directly', () => {
    const policy: ModelPolicy = { provider: 'anthropic', model: 'claude-sonnet' };
    const result = resolveModelPolicy(policy, settings());
    expect(result).toEqual({ provider: 'anthropic', model: 'claude-sonnet' });
  });

  // ── Named tiers ────────────────────────────────────────
  it('resolves "balanced" from agent.model setting', () => {
    const s = settings({ 'agent.model': 'gpt-4o' });
    expect(resolveModelPolicy('balanced', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  it('resolves "efficient" from agent.efficientModel setting', () => {
    const s = settings({
      'agent.efficientModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    expect(resolveModelPolicy('efficient', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  it('resolves "capable" from agent.capableModel setting', () => {
    const s = settings({
      'agent.capableModel': 'gpt-4o',
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
    // No agent.efficientModel set → falls back to agent.model
    expect(resolveModelPolicy('efficient', s)).toEqual({
      provider: 'openai',
      model: 'gpt-4o',
    });
  });

  // ── Relative tier (no parent) ─────────────────────────
  it('rejects relative tier when no parent policy is provided', () => {
    const s = settings();
    expect(() => resolveModelPolicy({ tier: 'lower' }, s)).toThrow(/relative model policy requires a parent/i);
  });

  // ── Relative tier with parent ─────────────────────────
  it('resolves relative "lower" tier against parent exact model', () => {
    const s = settings({
      'agent.efficientModel': 'gpt-4o-mini',
      'agent.provider': 'openai',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
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
      'agent.capableModel': 'gpt-4.1',
      'agent.provider': 'openai',
    });
    const parent: ModelPolicy = { provider: 'openai', model: 'gpt-4o' };
    expect(resolveModelPolicy({ tier: 'higher' }, s, parent)).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
    });
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
      'agent.efficientModel': 'claude-haiku',
    });
    const parent: ModelPolicy = { provider: 'anthropic', model: 'claude-sonnet' };
    expect(resolveModelPolicy({ tier: 'lower' }, s, parent)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku',
    });
  });
});
