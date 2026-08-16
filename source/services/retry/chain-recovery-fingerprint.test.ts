import { expect, it } from 'vitest';
import { fingerprintChainRequest } from './chain-recovery-fingerprint.js';

it('fingerprints provider, model, previous response, item types, and call IDs without output bodies', () => {
  const first = fingerprintChainRequest({
    provider: 'codex',
    model: 'gpt-5-codex',
    previousResponseId: 'resp-warmup',
    recoveryClass: 'chain_recovery',
    input: [
      { type: 'message', role: 'user', content: 'secret prompt' },
      { type: 'function_call_output', call_id: 'call_TPLbZgMcqd0guPBWHwDh1zjK', output: 'secret output' },
    ],
  });
  const second = fingerprintChainRequest({
    provider: 'codex',
    model: 'gpt-5-codex',
    previousResponseId: 'resp-warmup',
    recoveryClass: 'chain_recovery',
    input: [
      { type: 'message', role: 'user', content: 'different prompt' },
      { type: 'function_call_output', call_id: 'call_TPLbZgMcqd0guPBWHwDh1zjK', output: 'different output' },
    ],
  });

  expect(first).toBe(second);
  expect(first).not.toContain('secret');
  expect(first).toContain('function_call_output:call_TPLbZgMcqd0guPBWHwDh1zjK');
});

it('treats a missing previous response id as a different request', () => {
  const chained = fingerprintChainRequest({
    provider: 'codex',
    model: 'gpt-5-codex',
    previousResponseId: 'resp-warmup',
    recoveryClass: 'chain_recovery',
    input: [{ type: 'tool_result', id: 'call-1' }],
  });
  const fresh = fingerprintChainRequest({
    provider: 'codex',
    model: 'gpt-5-codex',
    previousResponseId: null,
    recoveryClass: 'chain_recovery',
    input: [{ type: 'tool_result', id: 'call-1' }],
  });

  expect(chained).not.toBe(fresh);
});
