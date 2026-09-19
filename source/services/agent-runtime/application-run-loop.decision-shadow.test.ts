import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StreamedModelTurn, StreamedModelTurnInput } from '../../contracts/streamed-model-turn.js';
import { RUN_CODE_EXECUTION_RESULT } from '../../tools/system/run-code/run-code-execution.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { DecisionShadowObserver } from '../decision-shadow/decision-shadow-observer.js';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import type { RunBudgetPolicy } from './run-budget.js';

const collect = async (stream: AsyncIterable<unknown>) => {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const baseAgent: ApplicationAgent = { name: 'root', instructions: 'help', model: 'model-a', tools: [] };

describe('ApplicationRunLoop decision-shadow observations', () => {
  it('observes exact requests and settled logical run_code choices without awaiting the observer', async () => {
    const order: string[] = [];
    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: vi.fn(() => order.push('observed')),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    let modelCalls = 0;
    const model: StreamedModelTurn = {
      async *stream() {
        order.push('streamed');
        modelCalls++;
        if (modelCalls === 1) {
          yield { type: 'tool_call', id: 'call-1', name: 'run_code', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-1', output: [] };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'resp-2',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    };
    const runCode: ToolDefinition = {
      name: 'run_code',
      description: 'script',
      parameters: z.object({}),
      needsApproval: () => false,
      execute: () =>
        Object.assign(new String('ok'), {
          [RUN_CODE_EXECUTION_RESULT]: {
            script: { status: 'succeeded', value: null, voidOutput: false },
            calls: [{ tool: 'grep', outcome: 'ok', durationMs: 1 }],
            actions: [],
            console: [],
            attachments: [],
          },
        }),
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model, decisionShadowObserver: observer });

    await collect(loop.startStream({ ...baseAgent, tools: [runCode] }, 'search', { providerId: 'openrouter' }));

    expect(order.slice(0, 2)).toEqual(['observed', 'streamed']);
    expect(observer.observeToolSelectionRequest).toHaveBeenCalledTimes(2);
    expect(observer.observeToolSelectionOutcome).toHaveBeenNthCalledWith(1, {
      requestId: expect.stringMatching(/^req-/),
      outcome: 'tools',
      selections: [{ name: 'grep', callPath: 'run_code' }],
    });
    expect(observer.observeToolSelectionOutcome).toHaveBeenNthCalledWith(2, {
      requestId: expect.stringMatching(/^req-/),
      outcome: 'text_only',
      selections: [],
    });
  });

  it('isolates observer exceptions from successful runtime behavior', async () => {
    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: () => {
        throw new Error('observer failed');
      },
      observeToolSelectionOutcome: () => {
        throw new Error('observer failed');
      },
      observeTerminalFailure: () => {
        throw new Error('observer failed');
      },
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield {
            type: 'completion',
            responseId: 'resp',
            output: [{ type: 'message', content: [{ type: 'text', text: 'unchanged' }] }],
          };
        },
      }),
      decisionShadowObserver: observer,
    });

    const stream = loop.startStream(baseAgent, 'hello', { providerId: 'openrouter' });
    await expect(stream.completed).resolves.toBeDefined();
    expect(stream.finalOutput).toBe('unchanged');
  });

  it('reports terminal failure evidence separately from classifier comparison labels', async () => {
    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: vi.fn(),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    const failure = Object.assign(new Error('rate limited'), {
      status: 429,
      code: 'rate_limit',
      retryAfterMs: 1500,
    });
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          throw failure;
        },
      }),
      decisionShadowObserver: observer,
    });
    const stream = loop.startStream(baseAgent, 'hello', { providerId: 'openrouter' });
    await expect(stream.completed).rejects.toThrow('rate limited');

    expect(observer.observeToolSelectionOutcome).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^req-/),
      outcome: 'failed',
      selections: [],
    });
    const terminal = vi.mocked(observer.observeTerminalFailure).mock.calls[0]![0];
    expect(terminal.evidence).toMatchObject({ status: 429, code: 'rate_limit', message: 'rate limited' });
    expect(terminal.evidence).not.toHaveProperty('retryable');
    expect(terminal.evidence).not.toHaveProperty('errorKind');
    expect(terminal.comparison).toMatchObject({ errorKind: 'rate_limit', retryable: true });
  });

  it('observes the final request after request preparation mutates the dispatch input', async () => {
    const observedInputs: unknown[] = [];
    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: (observation) => observedInputs.push(structuredClone(observation.input)),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield {
            type: 'completion',
            responseId: 'resp',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          };
        },
      }),
      decisionShadowObserver: observer,
    });
    const stream = loop.startStream(baseAgent, 'hello', {
      providerId: 'openrouter',
      requestPreparation: {
        prepare: (request) => {
          (request.input as StreamedModelTurnInput[]).push({
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'prepared' }],
          });
        },
        run: (operation) => operation(),
      },
    });
    await stream.completed;

    expect(JSON.stringify(observedInputs[0])).toContain('prepared');
  });

  it('does no optional failure classification when disabled and contains hostile evidence when enabled', async () => {
    let statusReads = 0;
    const hostile = new Error('original provider failure');
    Object.defineProperty(hostile, 'status', {
      get: () => {
        statusReads++;
        throw new Error('hostile status getter');
      },
    });
    const model: StreamedModelTurn = {
      async *stream() {
        throw hostile;
      },
    };

    const disabled = new ApplicationRunLoop({ resolveModel: () => model });
    await expect(disabled.startStream(baseAgent, 'hello').completed).rejects.toBe(hostile);
    expect(statusReads).toBe(0);

    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: vi.fn(),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    const enabled = new ApplicationRunLoop({ resolveModel: () => model, decisionShadowObserver: observer });
    await expect(enabled.startStream(baseAgent, 'hello').completed).rejects.toBe(hostile);
    expect(statusReads).toBe(1);
    expect(observer.observeTerminalFailure).not.toHaveBeenCalled();
  });

  it('settles failed predictions when tool dispatch throws before an observed selection', async () => {
    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: vi.fn(),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    const brokenTool: ToolDefinition = {
      name: 'broken',
      description: 'fails before dispatch',
      parameters: z.object({}),
      needsApproval: () => {
        throw new Error('approval policy failed');
      },
      execute: () => 'unused',
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield { type: 'tool_call', id: 'call-broken', name: 'broken', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp', output: [] };
        },
      }),
      decisionShadowObserver: observer,
    });
    const stream = loop.startStream({ ...baseAgent, tools: [brokenTool] }, 'break', { providerId: 'openrouter' });
    await expect(stream.completed).rejects.toThrow('approval policy failed');

    expect(observer.observeToolSelectionOutcome).toHaveBeenLastCalledWith({
      requestId: expect.stringMatching(/^req-/),
      outcome: 'failed',
      selections: [],
    });
  });

  it('settles retries, approval pauses, and tool-free critical wrap-up requests', async () => {
    const observer: DecisionShadowObserver = {
      observeToolSelectionRequest: vi.fn(),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    let attempts = 0;
    const retryLoop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          attempts++;
          if (attempts === 1) throw new Error('connection reset');
          yield {
            type: 'completion',
            responseId: 'retry-ok',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          };
        },
      }),
      waitBeforeModelRetry: async () => undefined,
      decisionShadowObserver: observer,
    });
    await retryLoop.startStream({ ...baseAgent, modelSettings: { retry: { maxRetries: 1 } } }, 'retry').completed;
    expect(observer.observeToolSelectionRequest).toHaveBeenCalledTimes(2);
    expect(observer.observeToolSelectionOutcome).toHaveBeenNthCalledWith(1, {
      requestId: expect.stringMatching(/^req-/),
      outcome: 'retried',
      selections: [],
    });

    const approvalTool: ToolDefinition = {
      name: 'approval_tool',
      description: 'pause',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => 'approved',
      formatCommandMessage: () => [],
    };
    const approvalLoop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield { type: 'tool_call', id: 'approval-call', name: 'approval_tool', arguments: '{}' };
          yield { type: 'completion', responseId: 'approval', output: [] };
        },
      }),
      decisionShadowObserver: observer,
    });
    await approvalLoop.startStream({ ...baseAgent, tools: [approvalTool] }, 'approve').completed;
    expect(observer.observeToolSelectionOutcome).toHaveBeenCalledWith({
      requestId: expect.stringMatching(/^req-/),
      outcome: 'tools',
      selections: [{ name: 'approval_tool', callPath: 'direct' }],
    });

    const policy: RunBudgetPolicy = {
      maxUsdMicros: 5_000_000,
      maxUnpricedTokens: 500_000,
      maxActiveTimeMs: 3_600_000,
      warningHeadroomUsdMicros: 1_000_000,
      warningHeadroomUnpricedTokens: 100_000,
      warningHeadroomActiveTimeMs: 900_000,
      softHeadroomUsdMicros: 250_000,
      softHeadroomUnpricedTokens: 25_000,
      softHeadroomActiveTimeMs: 300_000,
      turnBackstop: 0,
      extensionPercent: 50,
      maxParentExtensions: 2,
      escalation: 'pause',
      identicalToolCallThreshold: 3,
    };
    const wrapObserver: DecisionShadowObserver = {
      observeToolSelectionRequest: vi.fn(),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    const wrapLoop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield {
            type: 'completion',
            responseId: 'wrap',
            output: [{ type: 'message', content: [{ type: 'text', text: 'wrapped' }] }],
          };
        },
      }),
      decisionShadowObserver: wrapObserver,
    });
    await wrapLoop.startStream({ ...baseAgent, tools: [approvalTool] }, 'wrap', {
      runBudget: policy,
      wrapUpOnCriticalRunBudget: true,
    }).completed;
    expect(wrapObserver.observeToolSelectionRequest).toHaveBeenCalledWith(expect.objectContaining({ tools: [] }));
  });
});

it('distinguishes cancelled and retried provider requests from failures', async () => {
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    const observer = {
      observeToolSelectionRequest: vi.fn(),
      observeToolSelectionOutcome: vi.fn(),
      observeTerminalFailure: vi.fn(),
    };
    let attempts = 0;
    const loop = new ApplicationRunLoop({
      decisionShadowObserver: observer,
      waitBeforeModelRetry: async () => {},
      resolveModel: () => ({
        async *stream() {
          if (attempts++ === 0) {
            if (cancelled) {
              controller.abort();
              throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            }
            throw Object.assign(new Error('rate limited'), { status: 429 });
          }
          yield { type: 'completion' as const, responseId: 'retry-ok', output: [] };
        },
      }),
    });
    const stream = loop.startStream({ ...baseAgent, modelSettings: { retry: { maxRetries: 1 } } }, 'hello', {
      signal: controller.signal,
    });
    if (cancelled) await expect(stream.completed).rejects.toThrow();
    else await stream.completed;
    expect(observer.observeToolSelectionOutcome).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ outcome: cancelled ? 'cancelled' : 'retried' }),
    );
  }
});
