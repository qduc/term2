import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SandboxedCodeHostImpl } from './sandboxed-code-host.js';
import type { CapabilityHandler, CapabilityOutcome, HostResult } from './host-types.js';

const limits = {
  timeoutMs: 5_000,
  maxCodeBytes: 65_536,
  maxOutputBytes: 65_536,
  maxConsoleBytes: 65_536,
};

const echoCapability: CapabilityHandler = {
  binding: { name: 'tools', kind: 'namespace', members: ['echo'] },
  limits: { maxCalls: 4, maxConcurrency: 1, limitExceededMessage: 'too many calls' },
  prepare: () => ({}),
  invoke: async () => ({ kind: 'result', result: { answer: 'ok' } }),
};

describe('SandboxedCodeHostImpl isolation', () => {
  it('blocks host constructors on console, capabilities, and returned values', async () => {
    const consoleOutput: unknown[][] = [];
    const result = await new SandboxedCodeHostImpl().run({
      code: `
        let consoleEscaped = false;
        let capabilityEscaped = false;
        let promiseEscaped = false;
        let resultEscaped = false;
        try { console.log.constructor("return process")(); consoleEscaped = true; } catch (_) {}
        try { tools.echo.constructor("return process")(); capabilityEscaped = true; } catch (_) {}
        try { tools.echo({}).then.constructor("return process")(); promiseEscaped = true; } catch (_) {}
        try {
          const returned = await tools.echo({});
          returned.constructor.constructor("return process")();
          resultEscaped = true;
        } catch (_) {}
        console.log({ consoleEscaped, capabilityEscaped, promiseEscaped, resultEscaped });
      `,
      capabilities: { tools: echoCapability },
      limits,
      subject: 'Script',
      allowVoidOutput: true,
      onConsole: (values) => consoleOutput.push(values),
    });

    expect(result).toEqual({ ok: true, output: null, voidOutput: true });
    expect(consoleOutput).toEqual([
      [{ consoleEscaped: false, capabilityEscaped: false, promiseEscaped: false, resultEscaped: false }],
    ]);
  });
});

describe('SandboxedCodeHostImpl output rejection messages', () => {
  const run = (code: string, overrides: Partial<typeof limits> = {}) =>
    new SandboxedCodeHostImpl().run({
      code,
      capabilities: { tools: echoCapability },
      limits: { ...limits, ...overrides },
      subject: 'Script',
    });

  it('reports the actual size and the limit when output is too large', async () => {
    const result = await run(`return { blob: 'x'.repeat(5000) };`, { maxOutputBytes: 1_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_output');
    // The model can only choose between shrinking and chunking if it is told
    // how far over it went.
    expect(result.error.message).toMatch(/returned \d+ bytes, over the 1000-byte limit/);
    expect(result.error.message).toMatch(/batches/);
  });

  it('still accepts JSON-safe output inside the limit', async () => {
    const result = await run(`return { rows: [1, 2, 3] };`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({ rows: [1, 2, 3] });
  });

  it('drops undefined object fields instead of rejecting the return value', async () => {
    const result = await run(
      `return { kept: true, omitted: undefined, nested: { alsoOmitted: undefined, value: 1 } };`,
    );

    expect(result).toEqual({ ok: true, output: { kept: true, nested: { value: 1 } } });
  });

  it('encodes undefined array elements and holes as null', async () => {
    const result = await run(`return [1, undefined, , 2];`);

    expect(result).toEqual({ ok: true, output: [1, null, null, 2] });
  });

  it('reports the first unserializable function with its JSON path and completed effects', async () => {
    const result = await run(`
      const results = [await tools.echo({}), await tools.echo({}), { fn: () => undefined }];
      return { results, later: Symbol('later') };
    `);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'runtime_error',
        message:
          'Script return value is not JSON-safe: $.results[2].fn is a function.\n' +
          '2 nested tool calls already completed — inspect state before retrying.',
      },
    });
  });

  it('applies Date and custom toJSON values before serializing', async () => {
    const result = await run(`
      return {
        date: new Date('2026-01-02T03:04:05.000Z'),
        custom: { toJSON() { return { serialized: true }; } },
      };
    `);

    expect(result).toEqual({
      ok: true,
      output: {
        date: '2026-01-02T03:04:05.000Z',
        custom: { serialized: true },
      },
    });
  });

  it('reports a throwing getter with its JSON path and completed effects', async () => {
    const result = await run(`
      await tools.echo({});
      const output = {};
      Object.defineProperty(output, 'bad', { enumerable: true, get() { throw new Error('getter failed'); } });
      return { output };
    `);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'runtime_error',
        message:
          'Script return value is not JSON-safe: $.output.bad is a property that threw when read.\n' +
          '1 nested tool calls already completed — inspect state before retrying.',
      },
    });
  });

  it('uses bracket notation for non-identifier property names in JSON paths', async () => {
    const result = await run(`return { 'not-an-identifier': { fn: () => undefined } };`);

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'runtime_error',
        message:
          'Script return value is not JSON-safe: $["not-an-identifier"].fn is a function.\n' +
          '0 nested tool calls already completed — inspect state before retrying.',
      },
    });
  });

  it('preserves an own __proto__ property without changing the returned object prototype', async () => {
    const result = await run(`
      const output = {};
      Object.defineProperty(output, '__proto__', { value: { safe: true }, enumerable: true });
      return output;
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.output as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(output, '__proto__')?.value).toEqual({ safe: true });
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  it('excludes non-enumerable properties from the serialized return value', async () => {
    const result = await run(`
      const output = { visible: true };
      Object.defineProperty(output, 'hidden', { value: 'secret', enumerable: false });
      return output;
    `);

    expect(result).toEqual({ ok: true, output: { visible: true } });
  });

  it('drops symbol-keyed function properties without rejecting the return value', async () => {
    const result = await run(`
      const output = { visible: true };
      output[Symbol('function')] = () => undefined;
      return output;
    `);

    expect(result).toEqual({ ok: true, output: { visible: true } });
  });

  it.each([
    ['a cycle', `const value = {}; value.self = value; return value;`, '$.self'],
    ['a BigInt', `return { bad: 1n };`, '$.bad'],
    ['a symbol', `return { bad: Symbol('bad') };`, '$.bad'],
    ['a non-finite number', `return { bad: Number.NaN };`, '$.bad'],
  ])('reports %s with its JSON path', async (description, code, path) => {
    const result = await run(code);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('runtime_error');
    expect(result.error.message).toContain(`Script return value is not JSON-safe: ${path} is ${description}.`);
    expect(result.error.message).toContain('0 nested tool calls already completed — inspect state before retrying.');
  });

  it('keeps completed nested effects when an optional return field is undefined', async () => {
    const created: string[] = [];
    const createCapability: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['create'] },
      limits: { maxCalls: 4, maxConcurrency: 4, limitExceededMessage: 'too many calls' },
      prepare: (payload) => ({ path: (payload.params as { path: string }).path }),
      invoke: async (prepared) => {
        const path = (prepared as { path: string }).path;
        created.push(path);
        return { kind: 'result', result: { ok: true, result: { path } } };
      },
    };
    const host = new SandboxedCodeHostImpl();

    const result = await host.run({
      code: `
        const results = await Promise.all([
          tools.create({ path: 'one.txt' }),
          tools.create({ path: 'two.txt' }),
          tools.create({ path: 'three.txt' }),
        ]);
        return { results, selectedPath: undefined };
      `,
      capabilities: { tools: createCapability },
      limits,
      subject: 'Script',
    });

    expect(result).toEqual({
      ok: true,
      output: {
        results: [{ path: 'one.txt' }, { path: 'two.txt' }, { path: 'three.txt' }],
      },
    });
    expect(created).toEqual(['one.txt', 'two.txt', 'three.txt']);
  });

  it('serializes undefined fields on objects created in the vm realm', async () => {
    const result = await run(`
      const vmObject = { keep: 'yes', omit: undefined };
      const vmArray = [undefined, , 'last'];
      return { vmObject, vmArray };
    `);

    expect(result).toEqual({ ok: true, output: { vmObject: { keep: 'yes' }, vmArray: [null, null, 'last'] } });
  });
});

function createFakeWorker() {
  const posted: unknown[] = [];
  const worker = new EventEmitter() as EventEmitter & {
    postMessage: (message: unknown) => void;
    terminate: () => Promise<number>;
    posted: unknown[];
  };
  worker.posted = posted;
  worker.postMessage = (message: unknown) => {
    posted.push(message);
  };
  worker.terminate = async () => 0;
  return worker;
}

const protocolLimits = {
  timeoutMs: 1_000,
  maxCodeBytes: 65_536,
  maxOutputBytes: 65_536,
  maxConsoleBytes: 65_536,
};

const runWithFakeWorker = (
  handler: CapabilityHandler,
  worker: ReturnType<typeof createFakeWorker>,
  overrides: { timeoutMs?: number; signal?: AbortSignal } = {},
) =>
  new SandboxedCodeHostImpl().run({
    code: 'return 1;',
    capabilities: { tools: handler },
    limits: { ...protocolLimits, timeoutMs: overrides.timeoutMs ?? protocolLimits.timeoutMs },
    subject: 'Script',
    allowVoidOutput: true,
    signal: overrides.signal,
    workerFactory: () => worker as unknown as Worker,
  });

const stillRunning = async (pending: Promise<HostResult>) => {
  const marker = Symbol('running');
  expect(await Promise.race([pending, Promise.resolve(marker)])).toBe(marker);
};

describe('SandboxedCodeHostImpl Fork C clocks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not advance the work-clock across a human wait when idle arrives before onWaiting', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    let entered!: () => void;
    const inInvoke = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['prompt'] },
      limits: { maxCalls: 4, maxConcurrency: 1, limitExceededMessage: 'too many calls' },
      prepare: () => ({}),
      invoke: async (_prepared, context) => {
        entered();
        handler.onWaiting?.(context);
        try {
          await wait;
        } finally {
          handler.onResumed?.(context);
        }
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker);
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'prompt', params: {} });
    worker.emit('message', { type: 'workflow.idle', pending: ['1'], resultsConsumed: 0 });
    await inInvoke;
    await vi.advanceTimersByTimeAsync(5_000);
    await stillRunning(pending);
    resume();
    await vi.waitFor(() => expect(worker.posted.length).toBeGreaterThan(0));
    worker.emit('message', { type: 'workflow.complete', output: { done: true } });
    await expect(pending).resolves.toEqual({ ok: true, output: { done: true } });
  });

  it('advances the work-clock while a default-lane sibling runs during a wait', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    let promptEntered!: () => void;
    const inPrompt = new Promise<void>((resolve) => {
      promptEntered = resolve;
    });
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['prompt', 'fast'] },
      limits: { maxCalls: 8, maxConcurrency: 8, limitExceededMessage: 'too many calls' },
      prepare: (payload) => ({ member: payload.member }),
      lane: (prepared) => ((prepared as { member: string }).member === 'fast' ? 'default' : 'serial'),
      invoke: async (prepared, context) => {
        if ((prepared as { member: string }).member === 'prompt') {
          promptEntered();
          handler.onWaiting?.(context);
          await new Promise(() => undefined);
        }
        await new Promise(() => undefined);
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker);
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'prompt', params: {} });
    worker.emit('message', { type: 'workflow.idle', pending: ['1'], resultsConsumed: 0 });
    await inPrompt;
    worker.emit('message', { type: 'tools.run', requestId: '2', member: 'fast', params: {} });
    worker.emit('message', { type: 'workflow.busy', resultsConsumed: 0 });
    worker.emit('message', { type: 'workflow.idle', pending: ['1', '2'], resultsConsumed: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('does not pause on a stale idle racing a dispatched .result', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    let promptEntered!: () => void;
    const inPrompt = new Promise<void>((resolve) => {
      promptEntered = resolve;
    });
    let workEntered!: () => void;
    const inWork = new Promise<void>((resolve) => {
      workEntered = resolve;
    });
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['prompt', 'describe', 'work'] },
      limits: { maxCalls: 8, maxConcurrency: 8, limitExceededMessage: 'too many calls' },
      prepare: (payload): CapabilityOutcome | { member: unknown } => {
        if (payload.member === 'describe') return { kind: 'result', result: { ok: true } };
        return { member: payload.member };
      },
      invoke: async (prepared, context) => {
        if ((prepared as { member: string }).member === 'prompt') {
          promptEntered();
          handler.onWaiting?.(context);
          await new Promise(() => undefined);
        }
        workEntered();
        await new Promise(() => undefined);
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker);
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'prompt', params: {} });
    worker.emit('message', { type: 'workflow.idle', pending: ['1'], resultsConsumed: 0 });
    await inPrompt;
    worker.emit('message', { type: 'tools.run', requestId: '2', member: 'describe', params: 'work' });
    await vi.waitFor(() =>
      expect(worker.posted).toContainEqual({ type: 'tools.result', requestId: '2', result: { ok: true } }),
    );
    worker.emit('message', { type: 'tools.run', requestId: '3', member: 'work', params: {} });
    worker.emit('message', { type: 'workflow.busy', resultsConsumed: 1 });
    await inWork;
    worker.emit('message', { type: 'workflow.idle', pending: ['1'], resultsConsumed: 0 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('fires long-stop on a paused wait at max(timeoutMs, 1_800_000)', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    let entered!: () => void;
    const inInvoke = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['prompt'] },
      limits: { maxCalls: 4, maxConcurrency: 1, limitExceededMessage: 'too many calls' },
      prepare: () => ({}),
      invoke: async (_prepared, context) => {
        entered();
        handler.onWaiting?.(context);
        await new Promise(() => undefined);
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker);
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'prompt', params: {} });
    worker.emit('message', { type: 'workflow.idle', pending: ['1'], resultsConsumed: 0 });
    await inInvoke;
    await vi.advanceTimersByTimeAsync(1_799_999);
    await stillRunning(pending);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'deadline' } });
  });

  it('still bounds a never-idle loop with the work-clock', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['work'] },
      limits: { maxCalls: 4, maxConcurrency: 1, limitExceededMessage: 'too many calls' },
      prepare: () => ({}),
      invoke: async () => {
        await new Promise(() => undefined);
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker);
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'work', params: {} });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'timeout' } });
  });

  it('keys the waiting-set by worker requestId after a describe short-circuit, not callId', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    let seenRequestId: string | undefined;
    let seenCallId: number | undefined;
    let entered!: () => void;
    const inInvoke = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resume!: () => void;
    const wait = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['describe', 'prompt'] },
      limits: { maxCalls: 4, maxConcurrency: 1, limitExceededMessage: 'too many calls' },
      prepare: (payload): CapabilityOutcome | Record<string, never> => {
        if (payload.member === 'describe') return { kind: 'result', result: { ok: true } };
        return {};
      },
      invoke: async (_prepared, context) => {
        seenRequestId = context.requestId;
        seenCallId = context.callId;
        entered();
        handler.onWaiting?.(context);
        try {
          await wait;
        } finally {
          handler.onResumed?.(context);
        }
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker);
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'describe', params: 'prompt' });
    await vi.waitFor(() =>
      expect(worker.posted).toContainEqual({ type: 'tools.result', requestId: '1', result: { ok: true } }),
    );
    worker.emit('message', { type: 'tools.run', requestId: '2', member: 'prompt', params: {} });
    worker.emit('message', { type: 'workflow.idle', pending: ['2'], resultsConsumed: 1 });
    await inInvoke;
    expect(seenRequestId).toBe('2');
    expect(seenCallId).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    await stillRunning(pending);
    resume();
    await vi.waitFor(() =>
      expect(worker.posted).toContainEqual({ type: 'tools.result', requestId: '2', result: { ok: true } }),
    );
    worker.emit('message', { type: 'workflow.complete', output: { done: true } });
    await expect(pending).resolves.toEqual({ ok: true, output: { done: true } });
  });

  it('fails parent abort as cancelled rather than timeout', async () => {
    vi.useFakeTimers();
    const worker = createFakeWorker();
    const controller = new AbortController();
    const handler: CapabilityHandler = {
      binding: { name: 'tools', kind: 'namespace', members: ['work'] },
      limits: { maxCalls: 4, maxConcurrency: 1, limitExceededMessage: 'too many calls' },
      prepare: () => ({}),
      invoke: async () => {
        await new Promise(() => undefined);
        return { kind: 'result', result: { ok: true } };
      },
    };
    const pending = runWithFakeWorker(handler, worker, { signal: controller.signal });
    worker.emit('message', { type: 'tools.run', requestId: '1', member: 'work', params: {} });
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'cancelled', message: 'Script was cancelled by its parent' },
    });
  });
});
