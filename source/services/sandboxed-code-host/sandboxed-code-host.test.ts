import { describe, expect, it } from 'vitest';
import { SandboxedCodeHostImpl } from './sandboxed-code-host.js';
import type { CapabilityHandler } from './host-types.js';

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
});
