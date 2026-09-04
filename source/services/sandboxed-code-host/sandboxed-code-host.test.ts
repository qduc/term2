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

    expect(result).toEqual({ ok: true, output: null });
    expect(consoleOutput).toEqual([
      [{ consoleEscaped: false, capabilityEscaped: false, promiseEscaped: false, resultEscaped: false }],
    ]);
  });
});
