import { describe, expect, it, vi } from 'vitest';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import {
  enforceRequestInputLimit,
  isProviderContextOverflow,
  ProviderContextOverflowError,
} from './request-input-limit.js';
import { LocalContextCompactor } from './context-compaction/local-context-compactor.js';

const message = (content: string) => ({ role: 'user' as const, type: 'message' as const, content });
const agent: ApplicationAgent = { name: 'fixture', model: 'fixture', instructions: '', tools: [] };

describe('request input admission', () => {
  it('refuses live activation on an unobservable chain despite older observed usage', async () => {
    let limit: number | null = null;
    let requests = 0;
    const effect = vi.fn(() => {
      if (requests === 2) limit = 1000;
      return 'small new delta';
    });
    const stream = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          requests++;
          yield {
            type: 'completion' as const,
            responseId: `chain-${requests}`,
            output: [{ type: 'tool_call' as const, id: `call-${requests}`, name: 'read', arguments: '{}' }],
            ...(requests === 1 ? { usage: { inputTokens: 100, outputTokens: 10 } } : {}),
          };
        },
      }),
    }).startStream(
      {
        ...agent,
        tools: [
          {
            name: 'read',
            description: 'fixture',
            parameters: {},
            needsApproval: () => false,
            execute: effect,
            formatCommandMessage: () => [],
          },
        ],
      },
      [message('small delta')],
      {
        providerId: 'fixture',
        supportsConversationChaining: true,
        previousResponseId: 'existing-unobserved-chain',
        maxTurns: 3,
        requestInputLimit: () => limit,
      },
    );
    await expect(stream.completed).rejects.toMatchObject({
      code: 'request_input_limit',
      reason: 'unobservable_chained_context',
    });
    expect(requests).toBe(2);
    expect(effect).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(stream.history)).toContain('call-2');
  });
  it('refuses a fresh chain when neither full context nor observed usage is available', async () => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'unused', output: [] };
    });
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, modelSettings: { maxRequestInputTokens: 80000 } },
      [message('small delta')],
      {
        providerId: 'fixture',
        supportsConversationChaining: true,
        previousResponseId: 'unobserved-chain',
      },
    );
    await expect(stream.completed).rejects.toMatchObject({
      code: 'request_input_limit',
      reason: 'unobservable_chained_context',
    });
    expect(streamModel).not.toHaveBeenCalled();
  });
  it('honors a live disable when no independent agent ceiling is configured', async () => {
    let requests = 0;
    const stream = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          requests++;
          yield { type: 'completion' as const, responseId: 'fixture', output: [] };
        },
      }),
    }).startStream(agent, [message('x'.repeat(20000))], {
      requestInputLimit: () => null,
    });
    await stream.completed;
    expect(requests).toBe(1);
  });
  it('contains a single-turn worker when the real compactor refuses an unsafe cut', async () => {
    const generate = vi.fn(async () => ({ text: 'unused' }));
    const compactor = new LocalContextCompactor({ generate });
    const outcomes: string[] = [];
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'unused', output: [] };
    });
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, modelSettings: { maxRequestInputTokens: 80000 } },
      [message('x'.repeat(723470))],
      {
        boundaryCompaction: {
          compact: async ({ history }) => {
            const result = await compactor.compactAtBoundary({
              history,
              provider: 'fixture',
              model: 'fixture',
              sourceRevision: 0,
              contextWindow: 1048575,
              maxOutputTokens: 8192,
              compactThreshold: 0.8,
              compactThresholdTokens: 60000,
              manual: false,
            });
            outcomes.push(result.kind === 'blocked' ? result.reason : result.kind);
            return { kind: 'unchanged' };
          },
        },
      },
    );
    await expect(stream.completed).rejects.toMatchObject({ code: 'request_input_limit' });
    expect(outcomes).toEqual(['no_complete_cold_turn']);
    expect(generate).not.toHaveBeenCalled();
    expect(streamModel).not.toHaveBeenCalled();
  });
  it.each([999, 1000, 1001])('honors the last observed input at the ceiling boundary: %i', (observed) => {
    const check = () =>
      enforceRequestInputLimit({
        limit: 1000,
        history: [message('small')],
        instructions: '',
        tools: [],
        lastCompletedInputTokens: observed,
      });
    if (observed > 1000) expect(check).toThrowError(/configured ceiling/);
    else expect(check).not.toThrow();
  });

  it('checks instructions and tool definitions after request preparation', async () => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'fixture', output: [] };
    });
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, modelSettings: { maxRequestInputTokens: 1000 } },
      [message('small')],
      {
        requestPreparation: {
          prepare: (request) => {
            (request as { instructions: string }).instructions = 'x'.repeat(8000);
          },
          run: (dispatch) => dispatch(),
        },
      },
    );
    await expect(stream.completed).rejects.toMatchObject({ code: 'request_input_limit' });
    expect(streamModel).not.toHaveBeenCalled();
  });

  it('uses the live ceiling for transient agents that do not carry global model settings', async () => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'fixture', output: [] };
    });
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      agent,
      [message('x'.repeat(723470))],
      { requestInputLimit: () => 80000 },
    );
    await expect(stream.completed).rejects.toMatchObject({ code: 'request_input_limit' });
    expect(streamModel).not.toHaveBeenCalled();
  });
  it('rejects the incident-sized continuation before dispatch and without recording a billed request', async () => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'fixture-response', output: [] };
    });
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, modelSettings: { maxRequestInputTokens: 80_000, retry: { maxRetries: 2 } } },
      [message('x'.repeat(723_470))],
    );
    await expect(stream.completed).rejects.toMatchObject({ code: 'request_input_limit', limit: 80_000 });
    expect(streamModel).not.toHaveBeenCalled();
    expect(stream.runCostRecords ?? []).toEqual([]);
  });

  it('allows legitimate large input when the ceiling is explicitly raised', async () => {
    let requests = 0;
    const stream = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          requests++;
          yield { type: 'completion' as const, responseId: 'fixture-response', output: [] };
        },
      }),
    }).startStream({ ...agent, modelSettings: { maxRequestInputTokens: 200_000 } }, [message('x'.repeat(723_470))]);
    await stream.completed;
    expect(requests).toBe(1);
  });

  it('blocks unchecked tool-loop growth even when compaction fails, retaining the completed effect', async () => {
    let requests = 0;
    const effect = vi.fn(() => 'x'.repeat(400_000));
    const runAgent: ApplicationAgent = {
      ...agent,
      modelSettings: { maxRequestInputTokens: 80_000 },
      tools: [
        {
          name: 'read',
          description: 'fixture',
          parameters: {},
          needsApproval: () => false,
          execute: effect,
          formatCommandMessage: () => [],
        },
      ],
    };
    const stream = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          requests++;
          yield {
            type: 'completion' as const,
            responseId: 'fixture-response',
            output: [{ type: 'tool_call' as const, id: 'read-1', name: 'read', arguments: '{}' }],
          };
        },
      }),
    }).startStream(runAgent, [message('continue')], {
      maxTurns: 2,
      boundaryCompaction: { compact: async () => ({ kind: 'failed', provider: 'fixture' }) },
    });
    await expect(stream.completed).rejects.toMatchObject({ code: 'request_input_limit' });
    expect(requests).toBe(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(stream.history)).toContain('read-1');
  });

  it('does not resurrect obsolete usage after compaction when the next response omits usage', async () => {
    let requests = 0;
    const stream = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          requests++;
          yield {
            type: 'completion' as const,
            responseId: `fixture-${requests}`,
            output:
              requests < 3
                ? [{ type: 'tool_call' as const, id: `call-${requests}`, name: 'noop', arguments: '{}' }]
                : [],
            ...(requests === 1 ? { usage: { inputTokens: 42000, outputTokens: 10 } } : {}),
          };
        },
      }),
    }).startStream(
      {
        ...agent,
        modelSettings: { maxRequestInputTokens: 1_000 },
        tools: [
          {
            name: 'noop',
            description: 'fixture',
            parameters: {},
            needsApproval: () => false,
            execute: () => 'ok',
            formatCommandMessage: () => [],
          },
        ],
      },
      [message('start')],
      {
        maxTurns: 3,
        boundaryCompaction: {
          compact: async () =>
            requests === 1
              ? {
                  kind: 'compacted',
                  history: [message('summary: call-1 completed')],
                  modelInput: [message('summary: call-1 completed')],
                }
              : { kind: 'unchanged' },
        },
      },
    );
    await stream.completed;
    expect(requests).toBe(3);
  });
});

it('uses large model capacity beyond 96k and retains optional smaller ceilings', () => {
  const input = {
    history: [message('x'.repeat(500000))],
    instructions: 'retain this',
    tools: [],
    contextWindow: 1000000,
    maxOutputTokens: 32000,
  };
  expect(() => enforceRequestInputLimit({ ...input, limit: null })).not.toThrow();
  expect(() => enforceRequestInputLimit({ ...input, limit: 96000 })).toThrow(/configured ceiling/);
  expect(() =>
    enforceRequestInputLimit({ ...input, contextWindow: 32000, maxOutputTokens: 8000, limit: null }),
  ).toThrow(/known model capacity/);
});
it('retains an impossible explicit output allocation as a typed refusal', () => {
  expect(() =>
    enforceRequestInputLimit({
      history: [message('small task')],
      instructions: '',
      tools: [],
      contextWindow: 8192,
      maxOutputTokens: 8000,
    }),
  ).toThrow(/lower an explicit output allocation/);
});
it('uses the current provider/model on each new run instead of retaining large-model capacity', async () => {
  const dispatch = vi.fn(async function* () {
    yield { type: 'completion' as const, responseId: 'done', output: [] };
  });
  const loop = new ApplicationRunLoop({ resolveModel: () => ({ stream: dispatch }) });
  await loop.startStream(
    { ...agent, model: 'gpt-5.6-luna', modelSettings: { maxTokens: 32000 } },
    [message('x'.repeat(500000))],
    { providerId: 'openai' },
  ).completed;
  await expect(
    loop.startStream({ ...agent, model: 'gpt-4', modelSettings: { maxTokens: 2048 } }, [message('x'.repeat(500000))], {
      providerId: 'openai',
    }).completed,
  ).rejects.toMatchObject({ code: 'request_input_limit', reason: 'capacity_exceeded', capacity: 8192 });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it('parks structured overflow from an unknown provider without identical automatic retries', async () => {
  const dispatch = vi.fn(async function* () {
    throw Object.assign(new Error('provider capacity rejected'), { code: 'context_length_exceeded' });
  });
  const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: dispatch }) }).startStream(
    { ...agent, modelSettings: { retry: { maxRetries: 2 } } },
    [message('retained instructions')],
    { providerId: 'fixture' },
  );
  await expect(stream.completed).rejects.toMatchObject({ code: 'provider_context_overflow' });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(stream.history)).toContain('retained instructions');
});

describe('structured provider capacity evidence', () => {
  it('recognizes nested capacity codes behind numeric SDK status codes', () => {
    expect(isProviderContextOverflow({ code: 400, error: { code: 'context_length_exceeded' } })).toBe(true);
    expect(
      isProviderContextOverflow({ code: 400, responseBody: JSON.stringify({ error: { code: 'input_too_long' } }) }),
    ).toBe(true);
    expect(isProviderContextOverflow(new Error('wrapper', { cause: { code: 'max_context_length_exceeded' } }))).toBe(
      true,
    );
    expect(isProviderContextOverflow(new ProviderContextOverflowError(undefined))).toBe(true);
  });
  it('does not guess from generic failures or recurse through cyclic causes', () => {
    expect(isProviderContextOverflow(new Error('context too long'))).toBe(false);
    expect(isProviderContextOverflow({ code: 500, responseBody: 'invalid json' })).toBe(false);
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(isProviderContextOverflow(error)).toBe(false);
  });
});

it.each(['matched', 'unknown', 'already-settled'] as const)(
  'requires producing-call evidence for a tool-only continuation: %s',
  async (kind) => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'next', output: [] };
    });
    const history = [
      message('original request'),
      { type: 'function_call', callId: 'pending', name: 'read', arguments: '{}' },
      ...(kind === 'already-settled' ? [{ type: 'function_call_result', callId: 'pending', output: 'old' }] : []),
    ];
    const result = {
      type: 'function_call_result',
      callId: kind === 'unknown' ? 'unobserved' : 'pending',
      output: 'settled',
    };
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, model: 'gpt-5.6-luna' },
      [result],
      {
        providerId: 'codex',
        supportsConversationChaining: true,
        previousResponseId: 'prior',
        compactionHistory: history,
      },
    );
    if (kind === 'matched') {
      await stream.completed;
      expect(streamModel).toHaveBeenCalledTimes(1);
    } else {
      await expect(stream.completed).rejects.toMatchObject({
        code: 'request_input_limit',
        reason: 'unobservable_chained_context',
      });
      expect(streamModel).not.toHaveBeenCalled();
    }
  },
);

it.each(['function_call_result', 'function_call_output', 'custom_tool_call_output'] as const)(
  'aligns supported tool receipt representation %s',
  async (type) => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'next', output: [] };
    });
    const custom = type === 'custom_tool_call_output';
    const snapshot = [
      message('original'),
      {
        type: custom ? 'custom_tool_call' : 'function_call',
        call_id: 'call',
        name: 'read',
        arguments: '{}',
        input: 'read',
      },
    ];
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, model: 'gpt-5.6-luna' },
      [{ type, call_id: 'call', output: 'ok' }],
      {
        providerId: 'codex',
        supportsConversationChaining: true,
        previousResponseId: 'prior',
        compactionHistory: snapshot,
      },
    );
    await stream.completed;
    expect(streamModel).toHaveBeenCalledTimes(1);
  },
);
it.each(['duplicate', 'unknown', 'new-round'] as const)(
  'validates receipt evidence after intervening messages: %s',
  async (kind) => {
    const streamModel = vi.fn(async function* () {
      yield { type: 'completion' as const, responseId: 'next', output: [] };
    });
    const snapshot = [message('original'), { type: 'function_call', callId: 'pending', name: 'read', arguments: '{}' }];
    const delta = [
      { type: 'function_call_result', callId: 'pending', output: 'ok' },
      { type: 'message', role: 'assistant', content: 'continuing' },
      ...(kind === 'new-round' ? [{ type: 'function_call', callId: 'next', name: 'read', arguments: '{}' }] : []),
      { type: 'function_call_result', callId: kind === 'duplicate' ? 'pending' : 'next', output: 'ok' },
    ];
    const stream = new ApplicationRunLoop({ resolveModel: () => ({ stream: streamModel }) }).startStream(
      { ...agent, model: 'gpt-5.6-luna' },
      delta,
      {
        providerId: 'codex',
        supportsConversationChaining: true,
        previousResponseId: 'prior',
        compactionHistory: snapshot,
      },
    );
    if (kind === 'new-round') {
      await stream.completed;
      expect(streamModel).toHaveBeenCalledTimes(1);
    } else {
      await expect(stream.completed).rejects.toMatchObject({
        code: 'request_input_limit',
        reason: 'unobservable_chained_context',
      });
      expect(streamModel).not.toHaveBeenCalled();
    }
  },
);
