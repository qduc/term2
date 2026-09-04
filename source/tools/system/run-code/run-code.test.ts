import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { bindRunCodeRegistry, createRunCodeToolDefinition, TOOL_NAME_RUN_CODE } from './run-code.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { AnyToolDefinition, ToolRegistry } from '../../types.js';

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

const logging = (): ILoggingService =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() } as unknown as ILoggingService);

const build = (registry: ToolRegistry) =>
  createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry: () => registry,
    getCwd: () => workspace,
  });

const run = async (registry: ToolRegistry, code: string, params: Record<string, unknown> = {}) =>
  String(await build(registry).execute({ code, timeout_ms: 60_000, ...params } as never));

describe('run_code', () => {
  it('runs the script and returns its stdout', async () => {
    expect(await run([], 'console.log("hello from the script");')).toContain('hello from the script');
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

  it('never prompts for approval', async () => {
    expect(await build([]).needsApproval({ code: 'x' } as never)).toBe(false);
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
      } as never),
    );

    expect(output).toContain('undefined');
  });

  it('reports a script that throws, including the exit code and the stderr', async () => {
    const output = await run([], 'throw new Error("script failed on purpose");');

    expect(output).toContain('exited with code 1');
    expect(output).toContain('script failed on purpose');
  });

  it('reports a timeout rather than hanging the turn', async () => {
    const output = await run([], 'await new Promise((resolve) => setTimeout(resolve, 60_000));', {
      timeout_ms: 1_500,
    });

    expect(output).toContain('timed out');
  }, 20_000);

  it('rejects a non-positive timeout, which would otherwise disable the timer entirely', () => {
    const schema = build([]).parameters;

    expect(schema.safeParse({ code: 'x', timeout_ms: 0 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: -1 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: 1_000 }).success).toBe(true);
  });

  it('runs user code containing $-replacement patterns without corrupting the script', async () => {
    const output = await run([], `const marker = "a$'b$&c$\`d$$e"; console.log("literal:" + marker);`);

    expect(output).toContain(`literal:a$'b$&c$\`d$$e`);
  });

  it('stops the script when the caller aborts the turn', async () => {
    const controller = new AbortController();
    const pending = build([]).execute(
      { code: 'await new Promise((resolve) => setTimeout(resolve, 30_000));', timeout_ms: 60_000 } as never,
      { signal: controller.signal } as never,
    );
    setTimeout(() => controller.abort(), 300);

    const output = String(await pending);

    expect(output).not.toContain('30_000');
    expect(output.length).toBeGreaterThan(0);
  }, 20_000);

  it('forwards the tool invocation context to every tool the script calls', async () => {
    const seen: unknown[] = [];
    const output = await run(
      [
        tool({
          name: 'ctx',
          execute: (_params: unknown, context: unknown) => {
            seen.push(context);
            return 'ok';
          },
        }),
      ],
      'console.log(await tools.ctx({ value: "x" }));',
    );

    expect(output).toContain('ok');
    expect(seen).toHaveLength(1);
  });

  it('serialises calls to a tool that is not parallel-safe', async () => {
    let active = 0;
    let maxActive = 0;
    const output = await run(
      [
        tool({
          name: 'exclusive',
          execute: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return 'done';
          },
        }),
      ],
      `await Promise.all([1,2,3,4].map((n) => tools.exclusive({ value: String(n) })));
       console.log("finished");`,
    );

    expect(output).toContain('finished');
    expect(maxActive).toBe(1);
  }, 20_000);

  it('lets a parallel-safe tool overlap so fan-out stays fast', async () => {
    let active = 0;
    let maxActive = 0;
    await run(
      [
        tool({
          name: 'concurrent',
          parallelSafe: true,
          execute: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return 'done';
          },
        }),
      ],
      `await Promise.all([1,2,3,4].map((n) => tools.concurrent({ value: String(n) })));
       console.log("finished");`,
    );

    expect(maxActive).toBeGreaterThan(1);
  }, 20_000);
});

describe('bindRunCodeRegistry', () => {
  it('makes the script call the wrapped definitions, not the raw ones', async () => {
    const raw = tool({
      name: 'guarded',
      execute: () => 'RAW IMPLEMENTATION RAN',
    });
    const definition = createRunCodeToolDefinition({
      loggingService: logging(),
      getCwd: () => workspace,
    });

    // Mirrors agent-factory: the policy layer wraps each definition, then binds
    // the wrapped list into run_code.
    const wrapped: ToolRegistry = [
      { ...raw, execute: () => 'policy layer refused this call' },
      definition as unknown as AnyToolDefinition,
    ];
    bindRunCodeRegistry(wrapped);

    const output = String(
      await definition.execute({
        code: 'console.log(await tools.guarded({ value: "x" }));',
        timeout_ms: 60_000,
      } as never),
    );

    expect(output).toContain('policy layer refused this call');
    expect(output).not.toContain('RAW IMPLEMENTATION RAN');
  });

  it('exposes no tools at all when the registry was never bound', async () => {
    const definition = createRunCodeToolDefinition({
      loggingService: logging(),
      getCwd: () => workspace,
    });

    const output = String(
      await definition.execute({
        code: 'console.log("tool count:", Object.keys(tools).length);',
        timeout_ms: 60_000,
      } as never),
    );

    expect(output).toContain('tool count: 0');
  });
});
