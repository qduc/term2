import { describe, expect, it, vi } from 'vitest';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import { enforceRequestInputLimit } from './request-input-limit.js';
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
