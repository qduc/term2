import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';

const agent: ApplicationAgent = {
  name: 'parallel-test-agent',
  instructions: 'Be concise.',
  model: 'test-model',
  tools: [],
};

async function collect(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Drain the application event queue before asserting the completed state.
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function tool(
  name: string,
  execute: ToolDefinition['execute'],
  options: { parallelSafe?: boolean; needsApproval?: ToolDefinition['needsApproval'] } = {},
): ToolDefinition {
  return {
    name,
    description: name,
    parameters: z.object({}),
    parallelSafe: options.parallelSafe,
    needsApproval: options.needsApproval ?? (() => false),
    execute,
    formatCommandMessage: () => [],
  };
}

function modelForCalls(
  calls: Array<{ id: string; name: string }>,
  nextRequest: (request: Parameters<StreamedModelTurn['stream']>[0]) => void = () => {},
  streamed = false,
): StreamedModelTurn {
  let turn = 0;
  return {
    async *stream(request) {
      nextRequest(request);
      turn += 1;
      if (turn === 1) {
        if (streamed) {
          for (const call of calls) {
            yield { type: 'tool_call' as const, id: call.id, name: call.name, arguments: '{}' };
          }
          yield { type: 'completion', responseId: 'response-tools', output: [] };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'response-tools',
          output: calls.map((call) => ({ type: 'tool_call' as const, id: call.id, name: call.name, arguments: '{}' })),
        };
        return;
      }
      yield { type: 'completion', responseId: 'response-done', output: [] };
    },
  };
}

describe('ApplicationRunLoop parallel-safe tool dispatch', () => {
  it('settles a reverse-completing eligible batch in provider order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const executions: string[] = [];
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    const model = modelForCalls(
      [
        { id: 'call-first', name: 'first' },
        { id: 'call-second', name: 'second' },
      ],
      (request) => requests.push(request),
    );
    const loop = new ApplicationRunLoop({
      resolveModel: () => model,
    });
    const stream = loop.startStream(
      {
        ...agent,
        tools: [
          tool(
            'first',
            async () => {
              executions.push('first');
              return first.promise;
            },
            { parallelSafe: true },
          ),
          tool(
            'second',
            async () => {
              executions.push('second');
              return second.promise;
            },
            { parallelSafe: true },
          ),
        ],
      },
      'inspect',
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executions).toEqual(['first', 'second']);
    second.resolve('second result');
    first.resolve('first result');
    await stream.completed;

    expect(requests[1]?.input.filter((item) => item.type === 'tool_result').map((item) => item.id)).toEqual([
      'call-first',
      'call-second',
    ]);
  });

  it('treats a serial call as a barrier for later eligible calls', async () => {
    const first = deferred<string>();
    const executions: string[] = [];
    const model = modelForCalls([
      { id: 'call-first', name: 'first' },
      { id: 'call-serial', name: 'serial' },
      { id: 'call-last', name: 'last' },
    ]);
    const loop = new ApplicationRunLoop({
      resolveModel: () => model,
    });
    const stream = loop.startStream(
      {
        ...agent,
        tools: [
          tool(
            'first',
            async () => {
              executions.push('first');
              return first.promise;
            },
            { parallelSafe: true },
          ),
          tool('serial', () => {
            executions.push('serial');
            return 'serial result';
          }),
          tool(
            'last',
            () => {
              executions.push('last');
              return 'last result';
            },
            { parallelSafe: true },
          ),
        ],
      },
      'inspect',
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(executions).toEqual(['first']);
    first.resolve('first result');
    await stream.completed;
    expect(executions).toEqual(['first', 'serial', 'last']);
  });

  it('does not let an eligible call leap across an approval barrier', async () => {
    const executions: string[] = [];
    const model = modelForCalls([
      { id: 'call-first', name: 'first' },
      { id: 'call-approval', name: 'approval' },
      { id: 'call-last', name: 'last' },
    ]);
    const loop = new ApplicationRunLoop({
      resolveModel: () => model,
    });
    const stream = loop.startStream(
      {
        ...agent,
        tools: [
          tool(
            'first',
            () => {
              executions.push('first');
              return 'first result';
            },
            { parallelSafe: true },
          ),
          tool(
            'approval',
            () => {
              executions.push('approval');
              return 'approved result';
            },
            { needsApproval: () => true },
          ),
          tool(
            'last',
            () => {
              executions.push('last');
              return 'last result';
            },
            { parallelSafe: true },
          ),
        ],
      },
      'inspect',
    );

    await stream.completed;
    expect(executions).toEqual(['first']);
    expect(stream.interruptions).toHaveLength(1);

    (stream.state as any).approve?.(stream.interruptions![0]);
    const resumed = loop.continueRunStream(stream.state!);
    await resumed.completed;
    expect(executions).toEqual(['first', 'approval', 'last']);
  });

  it('awaits every started batch member when cancellation aborts the turn', async () => {
    const started: string[] = [];
    const settled: string[] = [];
    const makeCancellable = (name: string): ToolDefinition =>
      tool(
        name,
        async (_params, context) => {
          started.push(name);
          await new Promise<void>((resolve, reject) => {
            (context as { signal?: AbortSignal } | undefined)?.signal?.addEventListener(
              'abort',
              () => {
                settled.push(name);
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
              },
              { once: true },
            );
          });
        },
        { parallelSafe: true },
      );
    const model = modelForCalls([
      { id: 'call-first', name: 'first' },
      { id: 'call-second', name: 'second' },
    ]);
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream(
      { ...agent, tools: [makeCancellable('first'), makeCancellable('second')] },
      'inspect',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    loop.abort();

    await expect(stream.completed).rejects.toMatchObject({ name: 'AbortError' });
    expect(started).toEqual(['first', 'second']);
    expect(settled).toEqual(['first', 'second']);
    expect((stream.history as any[]).filter((item) => item.type === 'function_call_result')).toHaveLength(0);
  });

  it('uses the same provider-order transcript for streamed and terminal-only calls', async () => {
    const run = async (streamed: boolean) => {
      const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
      const model = modelForCalls(
        [
          { id: 'call-first', name: 'first' },
          { id: 'call-second', name: 'second' },
        ],
        (request) => requests.push(request),
        streamed,
      );
      const loop = new ApplicationRunLoop({ resolveModel: () => model });
      const stream = loop.startStream(
        {
          ...agent,
          tools: [
            tool('first', () => 'first result', { parallelSafe: true }),
            tool('second', () => 'second result', { parallelSafe: true }),
          ],
        },
        'inspect',
      );
      await stream.completed;
      return {
        history: (stream.history as any[]).map((item) => ({ type: item.type, id: item.id })),
        input: requests[1]?.input.map((item: any) => ({ type: item.type, id: item.id })),
      };
    };

    await expect(run(true)).resolves.toEqual(await run(false));
  });
});
