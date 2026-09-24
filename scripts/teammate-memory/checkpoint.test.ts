import { expect, it } from 'vitest';
import { buildCheckpointPair, formatCheckpointError, runCheckpointPair } from './checkpoint.js';
import type { StreamedModelTurnEvent } from '../../source/contracts/streamed-model-turn.js';

const fixture = {
  valid: true,
  snapshot: 'a1142650',
  model: 'codex/gpt-6-luna',
  aContext: 'Old index: only the title Codex nested-chain incident.',
  bContext: 'Child runs need distinct physical WebSocket identity; preserve root cache affinity and chaining.',
};

it('isolates the memory payload in a bounded pair of otherwise identical requests', () => {
  const pair = buildCheckpointPair(fixture);
  expect(pair).toHaveLength(2);
  expect(pair[0].arm).toBe('A');
  expect(pair[1].arm).toBe('B');
  expect(pair[0].request.input).toEqual(pair[1].request.input);
  expect(pair[0].request.tools).toEqual([]);
  expect(pair[0].request.instructions?.replace(fixture.aContext, '')).toBe(
    pair[1].request.instructions?.replace(fixture.bContext, ''),
  );
  expect(pair[0].maxReferenceUsd).toBeLessThan(0.08);
  expect(pair[1].maxReferenceUsd).toBeLessThan(0.08);
});

it('rejects altered or oversized preparation before any provider dispatch', () => {
  expect(() => buildCheckpointPair({ ...fixture, valid: false })).toThrow('invalid');
  expect(() => buildCheckpointPair({ ...fixture, model: 'openai/gpt-6-luna' })).toThrow('model');
  expect(() => buildCheckpointPair({ ...fixture, aContext: 'x'.repeat(33_000) })).toThrow('input');
});

it('settles one physical call per arm and refuses to continue after uncertain usage', async () => {
  const pair = buildCheckpointPair(fixture);
  const calls: string[] = [];
  const saved: string[] = [];
  const completed = (text: string): StreamedModelTurnEvent => ({
    type: 'completion',
    responseId: text,
    output: [{ type: 'message', content: [{ type: 'text', text }] }],
    usage: { inputTokens: 50, outputTokens: 20 },
  });
  const result = await runCheckpointPair(pair, {
    createModel: async (arm) => {
      calls.push(arm);
      return {
        async *stream() {
          yield completed(arm);
        },
      };
    },
    persist: async (result) => {
      saved.push(result.arm);
    },
  });
  expect(calls).toEqual(['A', 'B']);
  expect(saved).toEqual(['A', 'B']);
  expect(result.map((item) => item.text)).toEqual(['A', 'B']);

  calls.length = 0;
  await expect(
    runCheckpointPair(pair, {
      createModel: async (arm) => {
        calls.push(arm);
        return {
          async *stream() {
            yield { ...completed(arm), usage: undefined };
          },
        };
      },
      persist: async () => {},
    }),
  ).rejects.toThrow('usage');
  expect(calls).toEqual(['A']);
});

it('fails closed on tool calls or extra provider responses', async () => {
  const pair = buildCheckpointPair(fixture);
  let calls = 0;
  await expect(
    runCheckpointPair(pair, {
      createModel: async () => {
        calls++;
        return {
          async *stream() {
            yield { type: 'tool_call', id: 'c', name: 'shell', arguments: '{}' } as const;
          },
        };
      },
      persist: async () => {},
    }),
  ).rejects.toThrow('tool call');
  expect(calls).toBe(1);
});

it('does not print provider response headers or bodies on an HTTP failure', () => {
  const failure = Object.assign(new Error('provider body could include a secret'), {
    status: 400,
    headers: { 'set-cookie': 'sensitive-cookie' },
  });
  expect(formatCheckpointError(failure)).toBe('Checkpoint stopped: provider HTTP 400; no retry attempted.');
  expect(formatCheckpointError(new Error('secret from provider'))).toBe(
    'Checkpoint stopped: request failed; no retry attempted.',
  );
});
