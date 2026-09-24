import { expect, it } from 'vitest';
import { buildCheckpointPair, createCheckpointModel, formatCheckpointError, runCheckpointPair } from './checkpoint.js';
import type { StreamedModelTurnEvent } from '../../source/contracts/streamed-model-turn.js';
import { CodexResponsesTransport } from '../../source/providers/codex-responses-model.js';

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
  expect(pair[0].request).not.toHaveProperty('toolChoice');
  expect(pair[0].request.codex?.include).toEqual(['reasoning.encrypted_content']);
  expect(pair[0].request.instructions?.replace(fixture.aContext, '')).toBe(
    pair[1].request.instructions?.replace(fixture.bContext, ''),
  );
  expect(pair[0].maxReferenceUsd).toBeLessThan(0.08);
  expect(pair[1].maxReferenceUsd).toBeLessThan(0.08);
});

it('selects the established Codex websocket transport with retries disabled', async () => {
  const captured: { model?: string; transport?: unknown; retryAttempts?: number } = {};
  await createCheckpointModel({
    createStreamedModel: async (model, deps) => {
      captured.model = model;
      captured.transport = deps.settingsService.get('agent.transport');
      captured.retryAttempts = deps.retryAttempts;
      expect(deps.settingsService.get('agent.retryAttempts')).toBe(0);
      return { async *stream() {} };
    },
  });
  expect(captured).toEqual({ model: 'gpt-6-luna', transport: 'websocket', retryAttempts: 0 });
});

it('serializes the checkpoint without the unobserved HTTP tool_choice field', () => {
  const [a, b] = buildCheckpointPair(fixture);
  const transport = new CodexResponsesTransport({} as any, 'gpt-6-luna', true);
  const first = transport.buildResponsesCreateRequest(a.request, true).requestData;
  const second = transport.buildResponsesCreateRequest(b.request, true).requestData;
  for (const requestData of [first, second]) {
    expect(requestData).not.toHaveProperty('tool_choice');
    expect(requestData.include).toEqual(['reasoning.encrypted_content']);
    expect(requestData).toMatchObject({ model: 'gpt-6-luna', stream: true, reasoning: { effort: 'medium' } });
  }
  expect(Object.keys(first).sort()).toEqual(Object.keys(second).sort());
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
  const signals: AbortSignal[] = [];
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
        async *stream(request) {
          if (request.signal) signals.push(request.signal);
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
  expect(signals).toHaveLength(2);
  expect(signals[0]).not.toBe(signals[1]);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
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

it('fails closed on tool calls and closes the model after an incomplete stream', async () => {
  const pair = buildCheckpointPair(fixture);
  let calls = 0;
  let closes = 0;
  await expect(
    runCheckpointPair(pair, {
      createModel: async () => {
        calls++;
        return {
          async *stream() {
            yield { type: 'tool_call', id: 'c', name: 'shell', arguments: '{}' } as const;
          },
          async close() {
            closes++;
          },
        };
      },
      persist: async () => {},
    }),
  ).rejects.toThrow('tool call');
  expect(calls).toBe(1);
  expect(closes).toBe(1);
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
