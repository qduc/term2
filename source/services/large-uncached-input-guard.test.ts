import test from 'ava';
import { DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG, LargeUncachedInputGuard } from './large-uncached-input-guard.js';

const largeInput = () => 'x'.repeat(DEFAULT_LARGE_UNCACHED_INPUT_GUARD_CONFIG.largePromptTokenThreshold * 4);

test('warns above threshold after provider, model, or reasoning changes', (t) => {
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
  t.is(providerDecision.action, 'warn');
  t.true(providerDecision.reasons.includes('provider_changed'));

  const modelDecision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openai',
    model: 'gpt-5.1',
    reasoningEffort: 'medium',
    mode: 'standard',
  });
  t.is(modelDecision.action, 'warn');
  t.true(modelDecision.reasons.includes('model_changed'));

  const reasoningDecision = guard.inspect({
    input: largeInput(),
    now: 2_000,
    provider: 'openai',
    model: 'gpt-5',
    reasoningEffort: 'high',
    mode: 'standard',
  });
  t.is(reasoningDecision.action, 'warn');
  t.true(reasoningDecision.reasons.includes('reasoning_effort_changed'));
});

test('does not warn below threshold', (t) => {
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

  t.is(decision.action, 'allow');
});

test('warns after idle time exceeds five minutes', (t) => {
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

  t.is(decision.action, 'warn');
  t.true(decision.reasons.includes('idle_timeout'));
});

test('does not warn for Standard to Plan mode changes alone', (t) => {
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

  t.is(decision.action, 'allow');
});

test('warns for resumed large old sessions', (t) => {
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

  t.is(decision.action, 'warn');
  t.true(decision.reasons.includes('resumed_session_stale'));
});

test('warning key is stable for the same pending input and changes when input changes', (t) => {
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

  t.is(first.action, 'warn');
  t.is(second.action, 'warn');
  t.is(changed.action, 'warn');
  t.is(first.warningKey, second.warningKey);
  t.not(first.warningKey, changed.warningKey);
});
