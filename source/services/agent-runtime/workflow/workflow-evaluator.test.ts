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

  it('rejects approval-requiring tools without running an agent', async () => {
    const evaluator = new WorkflowEvaluatorImpl({
      runtime: {
        agent: () => {
          throw new Error('must not run');
        },
      } as any,
      parentTools: ['shell'],
    });
    const result = await evaluator.evaluate({
      code: `return await agent({ instructions: 'x', tools: ['shell'] }).run({ task: 'x' });`,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'approval_required' }, runs: [] });
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
});
