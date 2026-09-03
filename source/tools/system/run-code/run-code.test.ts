import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { z } from 'zod';
import { createRunCodeToolDefinition, TOOL_NAME_RUN_CODE } from './run-code.js';
import type { ILoggingService, ISettingsService } from '../../../services/service-interfaces.js';
import type { AnyToolDefinition, ToolRegistry } from '../../types.js';
import type { ShellSandboxRunner } from '../../../utils/shell/sandbox/sandbox-policy.js';

const workspace = process.cwd();
const noopFormatter = (() => []) as unknown as AnyToolDefinition['formatCommandMessage'];

const tool = (overrides: Partial<AnyToolDefinition> & { name: string }): AnyToolDefinition =>
  ({
    description: 'test tool',
    parameters: z.object({ value: z.string() }),
    needsApproval: () => false,
    execute: (params: unknown) => `echo:${(params as { value: string }).value}`,
    formatCommandMessage: noopFormatter,
    ...overrides,
  } as AnyToolDefinition);

const settings = (overrides: Record<string, unknown> = {}): ISettingsService =>
  ({
    get: (key: string) => ({ 'sandbox.enabled': true, ...overrides }[key]),
  } as unknown as ISettingsService);

const logging = (): ILoggingService =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() } as unknown as ILoggingService);

/**
 * Runs the real command unwrapped. The OS sandbox is not available in CI and is
 * not what these tests are about: the contract under test is that generated
 * code, the socket bridge, and the tool registry line up end to end.
 */
const passthroughSandbox = (overrides: Partial<ShellSandboxRunner> = {}): ShellSandboxRunner =>
  ({
    availability: async () => ({ type: 'available' }),
    wrap: async (command: string) => ({ command }),
    cleanupAfterCommand: () => {},
    annotateFailure: (_command: string, stderr: string) => stderr,
    ...overrides,
  } as ShellSandboxRunner);

const build = (registry: ToolRegistry, options: { settings?: ISettingsService; sandbox?: ShellSandboxRunner } = {}) =>
  createRunCodeToolDefinition({
    settingsService: options.settings ?? settings(),
    loggingService: logging(),
    getToolRegistry: () => registry,
    getCwd: () => workspace,
    shellSandboxRunner: options.sandbox ?? passthroughSandbox(),
    tsxPath: path.join(workspace, 'node_modules', '.bin', 'tsx'),
  });

const run = async (registry: ToolRegistry, code: string, options?: Parameters<typeof build>[1]) =>
  String(await build(registry, options).execute({ code, timeout_ms: 60_000 }));

describe('run_code', () => {
  it('runs the script and returns its stdout', async () => {
    const output = await run([], 'console.log("hello from the sandbox");');

    expect(output).toContain('hello from the sandbox');
  });

  it('calls a real tool through the bridge and returns its result to the script', async () => {
    const output = await run([tool({ name: 'echo' })], 'console.log(await tools.echo({ value: "round-trip" }));');

    expect(output).toContain('echo:round-trip');
    expect(output).toContain('1 tool call: echo');
  });

  it('lets a script loop over many tool calls in one execution', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `const out = [];
       for (const value of ["a", "b", "c"]) out.push(await tools.echo({ value }));
       console.log(out.join("|"));`,
    );

    expect(output).toContain('echo:a|echo:b|echo:c');
    expect(output).toContain('3 tool calls: echo×3');
  });

  it('surfaces a tool that needs approval as a catchable error and names it in the summary', async () => {
    const output = await run(
      [tool({ name: 'locked', needsApproval: () => true })],
      `try { await tools.locked({ value: "x" }); } catch (error) { console.log("caught:", (error as Error).message); }`,
    );

    expect(output).toContain('caught:');
    expect(output).toContain('needs user approval');
    expect(output).toContain('Refused (needs user approval, call these directly instead): locked');
  });

  it('never exposes run_code to the script, so a run cannot recurse', async () => {
    const registry: AnyToolDefinition[] = [tool({ name: 'echo' })];
    const definition = build(registry);
    registry.push(definition as unknown as AnyToolDefinition);

    const output = String(
      await definition.execute({
        code: `console.log(typeof (tools as Record<string, unknown>).${TOOL_NAME_RUN_CODE});`,
        timeout_ms: 60_000,
      }),
    );

    expect(output).toContain('undefined');
  });

  it('reports a script that throws, including the exit code and the stderr', async () => {
    const output = await run([], 'throw new Error("script failed on purpose");');

    expect(output).toContain('exited with code 1');
    expect(output).toContain('script failed on purpose');
  });

  it('reports a timeout rather than hanging the turn', async () => {
    const definition = build([]);

    const output = String(
      await definition.execute({
        code: 'await new Promise((resolve) => setTimeout(resolve, 60_000));',
        timeout_ms: 1_500,
      }),
    );

    expect(output).toContain('timed out');
  }, 20_000);

  it('refuses to run at all when the sandbox is turned off', async () => {
    const output = await run([], 'console.log("should not run");', {
      settings: settings({ 'sandbox.enabled': false }),
    });

    expect(output).toContain('Error: run_code requires the sandbox');
    expect(output).not.toContain('should not run');
  });

  it('refuses to fall back to an unsandboxed run when the sandbox is unavailable', async () => {
    const output = await run([], 'console.log("should not run");', {
      sandbox: passthroughSandbox({
        availability: async () => ({ type: 'missing_dependency', reason: 'no bwrap' }),
      }),
    });

    expect(output).toContain('Sandbox blocked this command');
    expect(output).not.toContain('should not run');
  });

  it('requires approval only when the sandbox cannot provide the boundary', async () => {
    await expect(build([]).needsApproval({ code: 'x' })).resolves.toBe(false);

    const unavailable = build([], {
      sandbox: passthroughSandbox({ availability: async () => ({ type: 'unsupported_platform', reason: 'n/a' }) }),
    });
    await expect(unavailable.needsApproval({ code: 'x' })).resolves.toBe(true);

    const disabled = build([], { settings: settings({ 'sandbox.enabled': false }) });
    await expect(disabled.needsApproval({ code: 'x' })).resolves.toBe(true);
  });
});
