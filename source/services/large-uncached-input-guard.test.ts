import { it, expect } from 'vitest';
import { DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG, LargeUncachedInputGuard } from './large-uncached-input-guard.js';

const largeInput = () => 'x'.repeat(DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.largePromptTokenThreshold * 4);

it('warns above threshold after provider, model, or reasoning changes', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const providerDecision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openrouter',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });
  expect(providerDecision.action).toBe('warn');
  expect(providerDecision.reasons.includes('provider_changed')).toBe(true);

  const modelDecision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openai',
    model: 'gpt-5.1',
    reasoningEffort: 'medium',
    mode: 'standard',
  });
  expect(modelDecision.action).toBe('warn');
  expect(modelDecision.reasons.includes('model_changed')).toBe(true);

  const reasoningDecision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'high',
    mode: 'standard',
  });
  expect(reasoningDecision.action).toBe('warn');
  expect(reasoningDecision.reasons.includes('reasoning_effort_changed')).toBe(true);
});

it('does not warn below threshold', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: largeInput(),
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: 'x'.repeat(1_000),
    now: 10 * 60 * 1_000,
    provider: 'openrouter',
    model: 'gpt-5.1',
    reasoningEffort: 'high',
    mode: 'lite',
  });

  expect(decision.action).toBe('allow');
});

it('uses estimated token size from the serialized outgoing input', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: largeInput(),
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const estimatedDecision = guard.inspect({
    input: largeInput(),
    now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 1,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(estimatedDecision.action).toBe('warn');
  expect(estimatedDecision.estimatedTokens >= DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.largePromptTokenThreshold).toBe(
    true,
  );
  expect(estimatedDecision.reasons.includes('idle_timeout')).toBe(true);
});

it('warns after idle time exceeds five minutes', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: largeInput(),
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: largeInput(),
    now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 1,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('warn');
  expect(decision.reasons.includes('idle_timeout')).toBe(true);
});

it('does not warn for Standard to Plan mode changes alone', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: largeInput(),
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'plan',
  });

  expect(decision.action).toBe('allow');
});

it('warns for resumed large old sessions', () => {
  const guard = new LargeUncachedInputGuard();
  guard.markResumedSession({ updatedAtMs: 1_000 });

  const decision = guard.inspect({
    input: largeInput(),
    now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 1,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('warn');
  expect(decision.reasons.includes('resumed_session_stale')).toBe(true);
});

it('warning key is stable for the same pending input and changes when input changes', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: largeInput(),
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const first = guard.inspect({
    input: largeInput(),
    now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 1,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });
  const second = guard.inspect({
    input: largeInput(),
    now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 2,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });
  const changed = guard.inspect({
    input: `${largeInput()} changed`,
    now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 2,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(first.action).toBe('warn');
  expect(second.action).toBe('warn');
  expect(changed.action).toBe('warn');
  expect(first.warningKey).toBe(second.warningKey);
  expect(first.warningKey).not.toBe(changed.warningKey);
});

// The guard runs against the full outgoing history, so every serialization of
// the payload costs time proportional to the conversation. When no risk factors
// apply, the decision is always allow regardless of size — skip the serialize.
it('does not serialize the payload when no warning reasons apply', () => {
  let serializations = 0;
  const countingInput = {
    history: 'x'.repeat(DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.largePromptTokenThreshold * 4),
    toJSON() {
      serializations++;
      return this.history;
    },
  };

  const guard = new LargeUncachedInputGuard();
  const decision = guard.inspect({
    input: countingInput,
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('allow');
  expect(decision.warningKey).toBe('');
  expect(serializations).toBe(0);
});

// When risk factors fire, size still gates the warning. Below-threshold inputs
// serialize once for the estimate and never hash a warning key.
it('serializes the payload once on a below-threshold allow with risk factors', () => {
  let serializations = 0;
  const countingInput = {
    history: 'x'.repeat(1_000),
    toJSON() {
      serializations++;
      return this.history;
    },
  };

  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: countingInput,
    now: 2_000,
    provider: 'openrouter',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('allow');
  expect(decision.warningKey).toBe('');
  expect(serializations).toBe(1);
});

// The warn path needs both a size estimate and a warning key. Reuse the same
// serialized string so a large history is not stringified twice.
it('serializes the payload once on the warn path', () => {
  let serializations = 0;
  const countingInput = {
    history: largeInput(),
    toJSON() {
      serializations++;
      return this.history;
    },
  };

  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: countingInput,
    now: 2_000,
    provider: 'openrouter',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('warn');
  expect(decision.warningKey).not.toBe('');
  expect(serializations).toBe(1);
});

it('mightWarn is false when session state cannot produce a warning', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(
    guard.mightWarn({
      now: 2_000,
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      mode: 'standard',
    }),
  ).toBe(false);
});

it('mightWarn is true after idle timeout', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(
    guard.mightWarn({
      now: 1_000 + DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.idleMs + 1,
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'medium',
      mode: 'standard',
    }),
  ).toBe(true);
});

it('still produces a stable warning key on the warn path', () => {
  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openrouter',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('warn');
  expect(decision.warningKey).not.toBe('');
});

// Composer previews pass a precomputed size (cached finalized history + draft)
// so inspect never stringifies the full transcript on each keystroke pause.
it('accepts precomputed estimatedBytes without serializing input', () => {
  let serializations = 0;
  const countingInput = {
    history: largeInput(),
    toJSON() {
      serializations++;
      return this.history;
    },
  };

  const guard = new LargeUncachedInputGuard();
  guard.recordSuccessfulInput({
    input: 'small',
    now: 1_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  const decision = guard.inspect({
    input: countingInput,
    estimatedBytes: DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.largePromptTokenThreshold * 4,
    contentKey: 'history:1\ndraft',
    now: 2_000,
    provider: 'openrouter',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    mode: 'standard',
  });

  expect(decision.action).toBe('warn');
  expect(decision.estimatedTokens).toBe(DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.largePromptTokenThreshold);
  expect(serializations).toBe(0);
});
