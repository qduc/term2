import test from 'ava';
import path from 'path';
import { getPromptPath } from './prompt-selector.js';

const basePromptDir = '/prompts';

test('getPromptPath prefers lite mode', (t) => {
  t.is(getPromptPath({ basePromptDir, model: 'gpt-5', liteMode: true }), path.join(basePromptDir, 'lite.md'));
});

test('getPromptPath selects anthropic prompt for sonnet or haiku', (t) => {
  t.is(
    getPromptPath({ basePromptDir, model: 'claude-3-sonnet', liteMode: false }),
    path.join(basePromptDir, 'anthropic.md'),
  );
  t.is(
    getPromptPath({ basePromptDir, model: ' Claude Haiku ', liteMode: false }),
    path.join(basePromptDir, 'anthropic.md'),
  );
});

test('getPromptPath selects codex prompt for gpt-5 codex', (t) => {
  t.is(getPromptPath({ basePromptDir, model: 'gpt-5-codex', liteMode: false }), path.join(basePromptDir, 'codex.md'));
  t.is(getPromptPath({ basePromptDir, model: 'gpt-5.3-codex', liteMode: false }), path.join(basePromptDir, 'codex.md'));
});

test('getPromptPath selects modern gpt-5 prompt for all non-codex gpt-5 models', (t) => {
  t.is(
    getPromptPath({ basePromptDir, model: ' GPT-5 ', liteMode: false }),
    path.join(basePromptDir, 'gpt-5-modern.md'),
  );
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-5.1', liteMode: false }),
    path.join(basePromptDir, 'gpt-5-modern.md'),
  );
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-5.2', liteMode: false }),
    path.join(basePromptDir, 'gpt-5-modern.md'),
  );
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-5.4-mini', liteMode: false }),
    path.join(basePromptDir, 'gpt-5.4-mini.md'),
  );
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-5.5-2026-04-23', liteMode: false }),
    path.join(basePromptDir, 'gpt-5.5.md'),
  );
});

test('getPromptPath falls back to simple prompt', (t) => {
  t.is(getPromptPath({ basePromptDir, model: 'gpt-4o', liteMode: false }), path.join(basePromptDir, 'simple.md'));
});

test('getPromptPath selects orchestrator prompt when orchestratorMode is true', (t) => {
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-4o', liteMode: false, orchestratorMode: true }),
    path.join(basePromptDir, 'orchestrator.md'),
  );
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-5', liteMode: false, orchestratorMode: true }),
    path.join(basePromptDir, 'orchestrator.md'),
  );
});

test('getPromptPath prefers lite over orchestrator when both are true', (t) => {
  t.is(
    getPromptPath({ basePromptDir, model: 'gpt-4o', liteMode: true, orchestratorMode: true }),
    path.join(basePromptDir, 'lite.md'),
  );
});
