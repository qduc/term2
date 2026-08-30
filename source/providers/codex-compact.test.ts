import { expect, it } from 'vitest';
import { compactOutputToProviderHistory } from './codex-compact.js';
import { OPENAI_RESPONSES_OPAQUE_TAG } from './provider-opaque-compatibility.js';
import { toCodexResponsesInput } from './codex-turn-converter.js';
import { normalizeApplicationInput } from '../services/agent-runtime/application-run-loop.js';

it('marks the compact endpoint compaction item as OpenAI-lane opaque history', () => {
  const history = compactOutputToProviderHistory([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'keep going' }],
    },
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
  ]);

  expect(history).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'keep going' }],
    },
    {
      type: 'compaction',
      id: 'cmp_1',
      encrypted_content: 'cipher',
      providerOpaque: { provider: OPENAI_RESPONSES_OPAQUE_TAG },
    },
  ]);
  expect(toCodexResponsesInput(normalizeApplicationInput(history))).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'keep going' }],
    },
    { type: 'compaction', id: 'cmp_1', encrypted_content: 'cipher' },
  ]);
});

it('rejects a non-object compact output item instead of inventing history', () => {
  expect(() => compactOutputToProviderHistory(['nope'])).toThrow(/non-object/);
});
