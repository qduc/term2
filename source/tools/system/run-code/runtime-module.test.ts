import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildRunnerSource, generateRuntime } from './runtime-module.js';
import type { AnyToolDefinition } from '../../types.js';

const noopFormatter = (() => []) as unknown as AnyToolDefinition['formatCommandMessage'];

const tool = (name: string, parameters: unknown, description = 'a tool'): AnyToolDefinition =>
  ({
    name,
    description,
    parameters,
    needsApproval: () => false,
    execute: () => '',
    formatCommandMessage: noopFormatter,
  } as AnyToolDefinition);

const generate = (registry: AnyToolDefinition[], socketPath = '/tmp/t2.sock') =>
  generateRuntime({ registry, socketPath });

describe('generateRuntime', () => {
  it('renders each tool as a typed member of the tools namespace', () => {
    const { toolsModule } = generate([tool('read_file', z.object({ path: z.string(), limit: z.number().optional() }))]);

    expect(toolsModule).toContain('read_file: (params: {');
    expect(toolsModule).toContain('path: string;');
    expect(toolsModule).toContain('limit?: number;');
    expect(toolsModule).toContain('export const tools: Tools');
  });

  it('binds every registered tool to a bridge call using its exact name', () => {
    const { toolsModule } = generate([tool('grep', z.object({ pattern: z.string() })), tool('glob', z.object({}))]);

    expect(toolsModule).toContain('grep: (params: unknown) => call("grep", params)');
    expect(toolsModule).toContain('glob: (params: unknown) => call("glob", params)');
  });

  it('embeds the socket path so the script needs no environment variable', () => {
    const { toolsModule } = generate([tool('echo', z.object({}))], '/tmp/run-code-abc.sock');

    expect(toolsModule).toContain('const SOCKET_PATH = "/tmp/run-code-abc.sock"');
  });

  it('renders enums, arrays and booleans as usable TypeScript', () => {
    const { toolsModule } = generate([
      tool(
        'shell',
        z.object({
          command: z.string(),
          mode: z.enum(['default', 'unsandboxed']),
          args: z.array(z.string()),
          background: z.boolean().optional(),
        }),
      ),
    ]);

    expect(toolsModule).toContain('mode: "default" | "unsandboxed";');
    expect(toolsModule).toContain('args: string[];');
    expect(toolsModule).toContain('background?: boolean;');
  });

  it('quotes a tool name that is not a valid identifier instead of emitting broken syntax', () => {
    const { toolsModule } = generate([tool('weird-name', z.object({}))]);

    expect(toolsModule).toContain('"weird-name": (params: unknown)');
  });

  it('falls back to unknown for a schema it cannot express, keeping the tool callable', () => {
    const { toolsModule } = generate([tool('opaque', { type: 'not-a-real-type' })]);

    expect(toolsModule).toContain('opaque: (params: unknown)');
    expect(toolsModule).toContain('opaque: (params: unknown) => call("opaque", params)');
  });

  it('carries tool and parameter descriptions into doc comments', () => {
    const { toolsModule } = generate([
      tool('grep', z.object({ pattern: z.string().describe('regex to search for') }), 'Search file contents'),
    ]);

    expect(toolsModule).toContain('/** Search file contents */');
    expect(toolsModule).toContain('/** regex to search for */');
  });

  it('neutralises a comment terminator in a description so the module still parses', () => {
    const { toolsModule } = generate([tool('t', z.object({}), 'ends the comment */ and then code')]);

    expect(toolsModule).not.toContain('*/ and then code');
  });
});

describe('buildRunnerSource', () => {
  it('places user code inside the async body where top-level await works', () => {
    const { runnerModule } = generate([tool('echo', z.object({}))]);

    const source = buildRunnerSource(runnerModule, 'const r = await tools.echo({});');

    expect(source).toContain('const r = await tools.echo({});');
    expect(source).toContain('await main();');
    expect(source).not.toContain('__USER_CODE__');
  });

  it('always disconnects the bridge so the script process can exit', () => {
    const { runnerModule } = generate([tool('echo', z.object({}))]);

    const source = buildRunnerSource(runnerModule, 'throw new Error("boom");');

    expect(source).toContain('finally {');
    expect(source).toContain('__disconnect();');
  });
});
