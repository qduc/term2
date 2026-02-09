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
});

test('getPromptPath selects gpt-5 prompt when gpt-5 without codex', (t) => {
  t.is(getPromptPath({ basePromptDir, model: ' GPT-5 ', liteMode: false }), path.join(basePromptDir, 'gpt-5.md'));
});

test('getPromptPath falls back to simple prompt', (t) => {
  t.is(getPromptPath({ basePromptDir, model: 'gpt-4o', liteMode: false }), path.join(basePromptDir, 'simple.md'));
});
