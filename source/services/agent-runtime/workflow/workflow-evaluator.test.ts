import { describe, expect, it, vi } from 'vitest';
import { createWorkflowSandbox } from './workflow-sandbox.js';
import { WorkflowEvaluatorImpl } from './workflow-evaluator.js';

describe('WorkflowEvaluator', () => {
  it('runs independent agents concurrently and returns a flat run log', async () => {
    let active = 0;
    let maximum = 0;
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: () => ({
          run: async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return { status: 'completed', output: 'ok' };
          },
        }),
      } as any,
      parentTools: ['read_file'],
      limits: { timeoutMs: 1_000, maxRuns: 2, maxConcurrency: 2, maxCodeBytes: 1_000, maxOutputBytes: 1_000 },
    });

    const result = await evaluator.evaluate({
      code: `return await Promise.all([1, 2].map(() => agent({ instructions: 'review', tools: ['read_file'] }).run({ task: 'x' })));`,
    });

    expect(result.ok).toBe(true);
    expect(maximum).toBe(2);
    expect(result.runs).toHaveLength(2);
  });

  it('preserves sequential run order', async () => {
    const started: string[] = [];
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: (config: any) => ({
          run: async () => (started.push(config.name), { status: 'completed', output: config.name }),
        }),
      } as any,
      parentTools: [],
    });

    const result = await evaluator.evaluate({
      code: "const one = await agent({ name: 'one', instructions: 'x' }).run({ task: 'x' }); const two = await agent({ name: 'two', instructions: 'x' }).run({ task: 'x' }); return [one, two];",
    });

    expect(started).toEqual(['one', 'two']);
    expect(result).toMatchObject({
      ok: true,
      output: [
        { ok: true, output: 'one' },
        { ok: true, output: 'two' },
      ],
    });
  });

  it('rejects cumulative runs beyond maxRuns', async () => {
    let created = 0;
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: { agent: () => ({ run: async () => (created++, { status: 'completed', output: 'ok' }) }) } as any,
      parentTools: [],
      limits: { maxRuns: 1 },
    });
    const result = await evaluator.evaluate({
      code: "const handle = agent({ instructions: 'x' }); await handle.run({ task: 'one' }); return handle.run({ task: 'two' });",
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(created).toBe(1);
  });

  it('cancels active child work when its parent is cancelled', async () => {
    const controller = new AbortController();
    let childAborted = false;
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: () => ({
          run: ({ signal }: any) => {
            childStarted();
            return new Promise((_, reject) =>
              signal.addEventListener('abort', () => {
                childAborted = true;
                reject(new Error('cancelled'));
              }),
            );
          },
        }),
      } as any,
      parentTools: [],
      limits: { timeoutMs: 1_000 },
    });
    const pending = evaluator.evaluate({
      code: "return agent({ instructions: 'x' }).run({ task: 'x' });",
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(childAborted).toBe(true);
  });

  it.each(['return 1;', 'throw new Error("bad workflow");'])('cleans up the worker after %s', async (code) => {
    let terminate: ReturnType<typeof vi.fn> | undefined;
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {} as any,
      parentTools: [],
      workerFactory: (source, timeout) => {
        const worker = createWorkflowSandbox(source, timeout);
        terminate = vi.spyOn(worker, 'terminate');
        return worker;
      },
    });
    await evaluator.evaluate({ code });
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('rejects output exceeding its byte limit', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [], limits: { maxOutputBytes: 8 } });
    await expect(evaluator.evaluate({ code: "return 'too long';" })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_output' },
    });
  });

  it('allows shell as an equivalent read interface when the parent has dedicated read tools', async () => {
    const agent = vi.fn(() => ({ run: async () => ({ status: 'completed', output: 'ok' }) }));
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: { agent } as any,
      parentTools: ['read_file', 'grep'],
    });
    const result = await evaluator.evaluate({
      code: `return await agent({ instructions: 'x', tools: ['shell'] }).run({ task: 'x' });`,
    });

    expect(result).toMatchObject({ ok: true, output: { ok: true, output: 'ok' } });
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['shell'],
        permissions: { tools: ['shell'] },
      }),
    );
  });

  it('allows dedicated read tools as equivalent interfaces when the parent has shell', async () => {
    const agent = vi.fn(() => ({ run: async () => ({ status: 'completed', output: 'ok' }) }));
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: { agent } as any,
      parentTools: ['shell'],
    });
    const result = await evaluator.evaluate({
      code: `return await agent({ instructions: 'x', tools: ['read_file', 'grep', 'glob'] }).run({ task: 'x' });`,
    });

    expect(result).toMatchObject({ ok: true, output: { ok: true, output: 'ok' } });
    expect(agent).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['read_file', 'grep', 'glob'],
        permissions: { tools: ['read_file', 'grep', 'glob'] },
      }),
    );
  });

  it('does not treat non-read tools as equivalent interfaces', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: ['read_file'] });
    const result = await evaluator.evaluate({
      code: `return await agent({ instructions: 'x', tools: ['web_search'] }).run({ task: 'x' });`,
    });

    expect(result).toMatchObject({
      ok: true,
      output: { ok: false, error: { code: 'permission_denied' } },
      runs: [],
    });
  });

  it('rejects an unsupported model tier before creating an agent', async () => {
    let created = 0;
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: () => {
          created++;
          throw new Error('must not run');
        },
      } as any,
      parentTools: [],
    });

    const result = await evaluator.evaluate({
      code: `return await agent({ instructions: 'x', model: 'unbounded' }).run({ task: 'x' });`,
    });

    expect(created).toBe(0);
    expect(result).toMatchObject({ ok: true, output: { ok: false, error: { code: 'agent_error' } } });
  });

  it('accepts JSON-safe output which reuses a non-circular object', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [] });

    const result = await evaluator.evaluate({ code: 'const value = { finding: true }; return [value, value];' });

    expect(result).toMatchObject({ ok: true, output: [{ finding: true }, { finding: true }] });
  });

  it('terminates an infinite loop without hanging the host', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [], limits: { timeoutMs: 20 } });
    const result = await evaluator.evaluate({ code: 'while (true) {}' });
    expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('does not expose Node globals to workflow code', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [] });
    const result = await evaluator.evaluate({ code: 'return [typeof process, typeof require, typeof Buffer];' });
    expect(result).toMatchObject({ ok: true, output: ['undefined', 'undefined', 'undefined'] });
  });

  it('reports syntax and runtime errors cleanly', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [] });
    await expect(evaluator.evaluate({ code: 'return (' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'syntax_error' },
    });
    await expect(evaluator.evaluate({ code: 'throw new Error("broken")' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_error' },
    });
  });

  it('marshals agent requests and results and captures console output', async () => {
    const consoleValues: unknown[][] = [];
    const run = vi.fn(async (input) => ({ status: 'completed', output: { task: input.task, context: input.context } }));
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: { agent: () => ({ run }) } as any,
      parentTools: [],
      onConsole: (values) => consoleValues.push(values),
    });
    const result = await evaluator.evaluate({
      code: "console.log('starting', { id: 1 }); return agent({ name: 'reviewer', instructions: 'review', model: 'lower' }).run({ task: 'inspect', context: { path: 'src' } });",
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ task: 'inspect', context: { path: 'src' } }));
    expect(consoleValues).toEqual([['starting', { id: 1 }]]);
    expect(result).toMatchObject({
      ok: true,
      output: { ok: true, output: { task: 'inspect', context: { path: 'src' } } },
    });
  });

  it('reports sandbox unavailability and keeps the host usable after worker termination', async () => {
    const unavailable = new WorkflowEvaluatorImpl({
      runtime: {} as any,
      parentTools: [],
      workerFactory: () => {
        throw new Error('workers disabled');
      },
    });
    await expect(unavailable.evaluate({ code: 'return 1;' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'sandbox_unavailable' },
    });

    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [] });
    await expect(evaluator.evaluate({ code: 'return 1;' })).resolves.toMatchObject({ ok: true, output: 1 });
    expect(1 + 1).toBe(2);
  });

  it('blocks constructor-based code generation escapes', async () => {
    const evaluator = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: [] });

    const result = await evaluator.evaluate({ code: "return this.constructor.constructor('return process')();" });

    expect(result).toMatchObject({ ok: false, error: { code: 'runtime_error' } });
  });

  it('admits all editor interfaces only when the parent has an editor, never shell alone', async () => {
    const agent = vi.fn(() => ({ run: async () => ({ status: 'completed', output: 'ok' }) }));
    const permitted = new WorkflowEvaluatorImpl({ runtime: { agent } as any, parentTools: ['apply_patch'] });
    await permitted.evaluate({
      code: "return agent({ instructions: 'x', tools: ['search_replace', 'create_file'] }).run({ task: 'x' });",
    });
    expect(agent).toHaveBeenCalledWith(expect.objectContaining({ tools: ['search_replace', 'create_file'] }));

    const denied = new WorkflowEvaluatorImpl({ runtime: {} as any, parentTools: ['shell'] });
    await expect(
      denied.evaluate({ code: "return agent({ instructions: 'x', tools: ['apply_patch'] }).run({ task: 'x' });" }),
    ).resolves.toMatchObject({ output: { ok: false, error: { code: 'permission_denied' } } });
  });

  it('admits web capabilities by exact parent tool name', async () => {
    const agent = vi.fn(() => ({ run: async () => ({ status: 'completed', output: 'ok' }) }));
    const evaluator = new WorkflowEvaluatorImpl({ runtime: { agent } as any, parentTools: ['web_search'] });
    await evaluator.evaluate({
      code: "return agent({ instructions: 'x', tools: ['web_search'] }).run({ task: 'x' });",
    });
    expect(agent).toHaveBeenCalled();
    await expect(
      evaluator.evaluate({ code: "return agent({ instructions: 'x', tools: ['web_fetch'] }).run({ task: 'x' });" }),
    ).resolves.toMatchObject({ output: { ok: false, error: { code: 'permission_denied' } } });
  });

  it('passes structured output unchanged and rejects malformed output or non-object context before creation', async () => {
    const run = vi.fn(async () => ({ status: 'failed', error: { code: 'invalid_schema', message: 'bad schema' } }));
    const evaluator = new WorkflowEvaluatorImpl({ runtime: { agent: () => ({ run }) } as any, parentTools: [] });
    const output = { schema: { type: 'object', unknownKeyword: true }, name: 'finding' };
    await evaluator.evaluate({
      code: `return agent({ instructions: 'x' }).run({ task: 'x', context: { path: 'a' }, output: ${JSON.stringify(
        output,
      )} });`,
    });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ output, context: { path: 'a' } }));
    await expect(
      evaluator.evaluate({ code: "return agent({ instructions: 'x' }).run({ task: 'x', context: [] });" }),
    ).resolves.toMatchObject({ output: { ok: false, error: { code: 'agent_error' } } });
    await expect(
      evaluator.evaluate({ code: "return agent({ instructions: 'x' }).run({ task: 'x', output: { schema: [] } });" }),
    ).resolves.toMatchObject({ output: { ok: false, error: { code: 'agent_error' } } });
  });

  it('keeps summaries in admission order and reports resolved handle metadata', async () => {
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: (config: any) => ({
          name: `resolved-${config.name}`,
          model: { provider: 'test-provider', model: 'test-model' },
          run: async () => {
            if (config.name === 'first') await new Promise((resolve) => setTimeout(resolve, 10));
            return { status: 'completed', output: config.name };
          },
        }),
      } as any,
      parentTools: [],
      limits: { maxConcurrency: 2 },
    });
    const result = await evaluator.evaluate({
      code: "return Promise.all(['first', 'second'].map(name => agent({ name, instructions: 'x' }).run({ task: 'x' })));",
    });
    expect(result.runs).toMatchObject([
      { runId: 1, requestedName: 'first', name: 'resolved-first', provider: 'test-provider', model: 'test-model' },
      { runId: 2, requestedName: 'second', name: 'resolved-second' },
    ]);
  });

  it('forwards only whole valid console messages within the cumulative budget', async () => {
    const logs: unknown[][] = [];
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {} as any,
      parentTools: [],
      limits: { maxConsoleBytes: 10 },
      onConsole: (values) => logs.push(values),
    });
    await evaluator.evaluate({ code: "console.log('ok'); console.log('too-long'); return 1;" });
    expect(logs).toEqual([['ok']]);
  });

  it('does not start queued admissions after parent cancellation', async () => {
    const controller = new AbortController();
    let created = 0;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => (started = resolve));
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: () => ({
          run: ({ signal }: any) => {
            created++;
            started();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
          },
        }),
      } as any,
      parentTools: [],
      limits: { maxConcurrency: 1, timeoutMs: 1_000 },
    });
    const pending = evaluator.evaluate({
      code: "return Promise.all([agent({ instructions: 'x' }).run({ task: 'one' }), agent({ instructions: 'x' }).run({ task: 'two' })]);",
      signal: controller.signal,
    });
    await firstStarted;
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
    expect(created).toBe(1);
  });

  it('releases a transferred queued permit when the workflow settles before its continuation', async () => {
    let finishFirst!: () => void;
    const firstFinished = new Promise<void>((resolve) => (finishFirst = resolve));
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => (firstStarted = resolve));
    const agent = vi.fn(() => ({
      run: async () => {
        firstStarted();
        await firstFinished;
        return { status: 'completed', output: 'first' };
      },
    }));
    const worker: any = {
      on: vi.fn(),
      once: vi.fn(),
      postMessage: vi.fn((message) => {
        if (message.requestId === 'first') messageListener({ type: 'workflow.complete', output: 'done' });
      }),
      terminate: vi.fn(async () => 0),
    };
    let messageListener!: (message: unknown) => void;
    worker.on.mockImplementation((event: string, listener: (message: unknown) => void) => {
      if (event === 'message') messageListener = listener;
      return worker;
    });
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: { agent } as any,
      parentTools: [],
      limits: { maxConcurrency: 1 },
      workerFactory: () => worker,
    });

    const pending = evaluator.evaluate({ code: 'return null;' });
    await vi.waitFor(() => expect(messageListener).toBeTypeOf('function'));
    messageListener({ type: 'agent.run', requestId: 'first', config: { instructions: 'x' }, input: { task: 'one' } });
    messageListener({ type: 'agent.run', requestId: 'second', config: { instructions: 'x' }, input: { task: 'two' } });
    await started;
    finishFirst();

    await expect(pending).resolves.toMatchObject({ ok: true, output: 'done' });
    expect(agent).toHaveBeenCalledTimes(1);
  });
});
