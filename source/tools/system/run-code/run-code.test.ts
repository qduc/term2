import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  bindRunCodeRegistry,
  createRunCodeToolDefinition,
  RUN_CODE_LIMITS,
  RUN_CODE_PROHIBITED_TOOLS,
  TOOL_NAME_RUN_CODE,
} from './run-code.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import { wrapNeedsApproval } from '../../../lib/tool-invoke.js';
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

const makeApprovalRegistry = (registry: ToolRegistry): ToolApprovalPolicyRegistry => {
  const approvalRegistry = new ToolApprovalPolicyRegistry();
  for (const candidate of registry) {
    approvalRegistry.register({
      toolName: candidate.name,
      parameters: candidate.parameters,
      needsApproval: candidate.needsApproval,
    });
  }
  return approvalRegistry;
};

const build = (registry: ToolRegistry, approvalPolicyRegistry = makeApprovalRegistry(registry)) =>
  createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry: () => registry,
    getCwd: () => workspace,
    approvalPolicyRegistry,
  });

const run = async (
  registry: ToolRegistry,
  code: string,
  params: Record<string, unknown> = {},
  approvalPolicyRegistry = makeApprovalRegistry(registry),
) => String(await build(registry, approvalPolicyRegistry).execute({ code, timeout_ms: 60_000, ...params } as never));

describe('run_code', () => {
  it('returns an explicitly requested debugging trace', async () => {
    expect(await run([], 'console.log("hello from the script");', { include_console: true })).toContain(
      'hello from the script',
    );
  });

  it('returns the script completion value and suppresses console trace on success', async () => {
    const output = await run([], 'console.log("debug trace"); return { answer: "the result" };');

    expect(output).toContain('Result:\n{"answer":"the result"}');
    expect(output).not.toContain('debug trace');
  });

  it('includes console trace on failure so the error remains actionable', async () => {
    const output = await run([], 'console.log("debug trace"); throw new Error("broken");');

    expect(output).toContain('Script failed');
    expect(output).toContain('debug trace');
  });

  it('includes console trace on success only when explicitly requested', async () => {
    const output = await run([], 'console.log("debug trace"); return "the result";', { include_console: true });

    expect(output).toContain('Result:\nthe result');
    expect(output).toContain('debug trace');
  });

  it('clips an opted-in console trace without clipping the completion value away', async () => {
    const output = await run([], `console.log("trace ".repeat(10_000)); return "answer";`, {
      include_console: true,
    });

    expect(output).toContain('Result:\nanswer');
    expect(output).toContain('[truncated: output exceeded');
    expect(output.length).toBeLessThanOrEqual(30_000);
  });

  it('explains that a successful script with no return value produces no result', async () => {
    const output = await run([], 'console.log("debug trace only");');

    expect(output).toContain('Script returned no result. Return a value from the script');
    expect(output).not.toContain('debug trace only');
  });

  it('preserves null as an explicit completion value', async () => {
    expect(await run([], 'return null;')).toContain('Result:\nnull');
  });

  it('does not let a real describe tool shadow metadata lookup', async () => {
    const execute = vi.fn(() => 'real describe result');
    const toolDefinition = tool({ name: 'describe', execute });

    expect(await run([toolDefinition], 'return await tools.describe({ value: "x" });')).toContain(
      'real describe result',
    );
    expect(await run([toolDefinition], 'return await tools.describe("describe");')).toContain('"name":"describe"');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('calls a real tool and returns its result to the script', async () => {
    const output = await run([tool({ name: 'echo' })], 'return await tools.echo({ value: "round-trip" });');

    expect(output).toContain('echo:round-trip');
    expect(output).toContain('1 tool call: echo');
  });

  it('executes a genuinely auto-approved tool from inside a script', async () => {
    const execute = vi.fn(() => 'auto-approved result');
    const output = await run(
      [tool({ name: 'auto', execute, needsApproval: () => false })],
      'return await tools.auto({ value: "x" });',
    );

    expect(output).toContain('auto-approved result');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('lets a script loop over many tool calls in one execution', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `const out = [];
       for (const value of ["a", "b", "c"]) out.push(await tools.echo({ value }));
       return out.join("|");`,
    );

    expect(output).toContain('echo:a|echo:b|echo:c');
    expect(output).toContain('3 tool calls: echo×3');
  });

  it('never prompts for approval', async () => {
    expect(await build([]).needsApproval({ code: 'x' } as never)).toBe(false);
  });

  it('rejects a call whose parameters fail the real schema, without running the tool', async () => {
    const execute = vi.fn(() => 'must not run');
    const output = await run(
      [tool({ name: 'strict', execute })],
      `try { await tools.strict({ value: 42 }); } catch (error) { console.log("caught:", error.message); }`,
      { include_console: true },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(output).toContain('Invalid parameters for "strict"');
  });

  it('exposes exactly the registry, so an unknown tool name is simply absent', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `console.log("names:", Object.keys(tools).join(","), "missing:", typeof tools.missing);`,
      { include_console: true },
    );

    expect(output).toContain('names: echo,describe missing: undefined');
  });

  it('truncates an oversized tool result with an explicit marker', async () => {
    const output = await run(
      [tool({ name: 'big', execute: () => 'x'.repeat(RUN_CODE_LIMITS.maxResultChars + 100) })],
      `const result = await tools.big({ value: "x" });
       console.log("truncated:", result.includes("[truncated: result exceeded"), result.length < ${
         RUN_CODE_LIMITS.maxResultChars + 100
       });`,
      { include_console: true },
    );

    expect(output).toContain('truncated: true true');
  });

  it('stops the script at its call budget instead of letting it loop forever', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `let calls = 0;
       try {
         for (let i = 0; i < ${RUN_CODE_LIMITS.maxCalls + 5}; i++) { await tools.echo({ value: "x" }); calls++; }
       } catch (error) { console.log("stopped after", calls, error.message); }`,
      { timeout_ms: 30_000, include_console: true },
    );

    expect(output).toContain(`stopped after ${RUN_CODE_LIMITS.maxCalls}`);
    expect(output).toContain('Tool call limit reached');
  }, 30_000);

  it('surfaces a tool that needs approval as a catchable error and names it in the summary', async () => {
    const output = await run(
      [tool({ name: 'locked', needsApproval: () => true })],
      `try { await tools.locked({ value: "x" }); } catch (error) { console.log("caught:", error.message); }`,
      { include_console: true },
    );

    expect(output).toContain('caught:');
    expect(output).toContain('requires approval and is unavailable from inside a script');
    expect(output).toContain('Refused (needs user approval, call these directly instead): locked');
  });

  it('denies a tool with no registered approval policy', async () => {
    const execute = vi.fn(() => 'must not run');
    const output = await run(
      [tool({ name: 'unknown-policy', execute })],
      'try { await tools["unknown-policy"]({ value: "x" }); } catch (error) { console.log(error.message); }',
      { include_console: true },
      new ToolApprovalPolicyRegistry(),
    );

    expect(output).toContain('has no registered approval policy and is unavailable from inside a script');
    expect(output).toContain('Unavailable (no registered approval policy');
    expect(output).not.toContain('requires approval');
    expect(execute).not.toHaveBeenCalled();
  });

  it('never exposes run_code to the script, so a run cannot recurse', async () => {
    const registry: AnyToolDefinition[] = [tool({ name: 'echo' })];
    const definition = build(registry);
    registry.push(definition as unknown as AnyToolDefinition);

    const output = String(
      await definition.execute({
        code: `console.log(typeof tools.${TOOL_NAME_RUN_CODE});`,
        timeout_ms: 60_000,
        include_console: true,
      } as never),
    );

    expect(output).toContain('undefined');
  });

  it.each([...RUN_CODE_PROHIBITED_TOOLS])('never exposes the prohibited tool %s', async (name) => {
    const execute = vi.fn(() => 'must not run');
    const output = await run(
      [tool({ name, execute }), tool({ name: 'echo' })],
      `console.log("exposed:", typeof tools[${JSON.stringify(name)}]);
       console.log("names:", Object.keys(tools).join(","));`,
      { include_console: true },
    );

    expect(output).toContain('exposed: undefined');
    expect(output).toContain('names: echo');
    expect(execute).not.toHaveBeenCalled();
  });

  it('omits prohibited tools from the description it advertises', () => {
    const description = build([
      tool({ name: 'run_subagent' }),
      tool({ name: 'shell' }),
      tool({ name: 'echo' }),
    ]).description;

    expect(description).toContain('tools.echo');
    expect(description).not.toContain('run_subagent');
    expect(description).not.toContain('tools.shell(');
    expect(description).toContain('Auto-approved tools run normally');
    expect(description).toContain('requires user approval is unavailable from inside a script');
  });

  it('teaches the model to return a value and describes the console opt-in', () => {
    const description = build([]).description;

    expect(description).toContain('Return the value you want the model to receive');
    expect(description).toContain('`console.log` is a debugging trace');
    expect(description).toContain('include_console');
    expect(description).not.toContain('print results with console.log');
    expect(description).not.toContain('return only inside your own functions');
  });

  it('describes an exposed tool with its full schema and description', async () => {
    const output = await run(
      [
        tool({
          name: 'inspect',
          description: 'Inspect a target.',
          parameters: z.object({ target: z.string(), deep: z.boolean().optional() }),
        }),
      ],
      'return await tools.describe("inspect");',
    );

    expect(output).toContain('"name":"inspect"');
    expect(output).toContain('"description":"Inspect a target."');
    expect(output).toContain('"target"');
    expect(output).toContain('"deep"');
  });

  it('does not charge metadata lookup against the tool-call budget', async () => {
    const output = await run(
      [tool({ name: 'inspect' })],
      `for (let i = 0; i < ${RUN_CODE_LIMITS.maxCalls + 1}; i++) await tools.describe("inspect");
       return await tools.inspect({ value: "ok" });`,
    );

    expect(output).toContain('Result:\necho:ok');
    expect(output).toContain('1 tool call: inspect');
    expect(output).not.toContain('Tool call limit reached');
  });

  it('uses the namespace unknown-tool wording for prohibited and absent descriptions', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `for (const name of ["shell", "missing"]) {
        try { await tools.describe(name); } catch (error) { console.log(error.message); }
      }`,
      { include_console: true },
    );

    expect(output).toContain('Unknown tool "shell". Available: echo');
    expect(output).toContain('Unknown tool "missing". Available: echo');
  });

  it('reports a script that throws', async () => {
    const output = await run([], 'throw new Error("script failed on purpose");');

    expect(output).toContain('Script failed');
    expect(output).toContain('script failed on purpose');
  });

  it('reports a timeout rather than hanging the turn', async () => {
    const output = await run([], 'while (true) {}', { timeout_ms: 1_500 });

    expect(output).toContain('timed out');
  }, 20_000);

  it('rejects a non-positive timeout, which would otherwise disable the timer entirely', () => {
    const schema = build([]).parameters;

    expect(schema.safeParse({ code: 'x', timeout_ms: 0 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: -1 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: 1_000 }).success).toBe(true);
  });

  it('gives the script no filesystem, network, or ambient host globals', async () => {
    const output = await run(
      [],
      `console.log([typeof process, typeof require, typeof Buffer, typeof globalThis.fetch].join(","));`,
      { include_console: true },
    );

    expect(output).toContain('undefined,undefined,undefined,undefined');
  });

  it('stops the script when the caller aborts the turn', async () => {
    const controller = new AbortController();
    const pending = build([]).execute(
      { code: 'while (true) {}', timeout_ms: 60_000 } as never,
      { signal: controller.signal } as never,
    );
    setTimeout(() => controller.abort(), 300);

    const output = String(await pending);

    expect(output).toContain('cancelled by its parent');
  }, 20_000);

  it('aborts an in-flight nested tool when the script deadline fires', async () => {
    const nestedAborted = vi.fn();
    const definition = build([
      tool({
        name: 'slow',
        execute: async (_params: unknown, context: unknown) => {
          const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              nestedAborted();
              resolve();
              return;
            }
            signal?.addEventListener(
              'abort',
              () => {
                nestedAborted();
                resolve();
              },
              { once: true },
            );
          });
          return 'aborted';
        },
      }),
    ]);

    const output = String(
      await definition.execute({ code: 'await tools.slow({ value: "x" });', timeout_ms: 500 } as never),
    );

    expect(output).toContain('timed out');
    await vi.waitFor(() => expect(nestedAborted).toHaveBeenCalledOnce());
  }, 20_000);

  it('passes caller cancellation to an in-flight nested tool', async () => {
    const nestedAborted = vi.fn();
    const definition = build([
      tool({
        name: 'slow',
        execute: async (_params: unknown, context: unknown) => {
          const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
          await new Promise<void>((resolve) =>
            signal?.addEventListener(
              'abort',
              () => {
                nestedAborted();
                resolve();
              },
              { once: true },
            ),
          );
          return 'aborted';
        },
      }),
    ]);
    const controller = new AbortController();
    const pending = definition.execute(
      { code: 'await tools.slow({ value: "x" });', timeout_ms: 60_000 } as never,
      { signal: controller.signal } as never,
    );
    setTimeout(() => controller.abort(), 50);

    const output = String(await pending);

    expect(output).toContain('cancelled by its parent');
    await vi.waitFor(() => expect(nestedAborted).toHaveBeenCalledOnce());
  }, 20_000);

  it('forwards the tool invocation context to every tool the script calls', async () => {
    const seen: unknown[] = [];
    const definition = build([
      tool({
        name: 'ctx',
        execute: (_params: unknown, context: unknown) => {
          seen.push(context);
          return 'ok';
        },
      }),
    ]);
    const marker = { signal: undefined, marker: 'caller-context' };

    await definition.execute(
      { code: 'console.log(await tools.ctx({ value: "x" }));', timeout_ms: 60_000 } as never,
      marker as never,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.objectContaining({ marker: 'caller-context' }));
    expect((seen[0] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it('passes a unique namespaced bridge call ID to each tool execution', async () => {
    const details: unknown[] = [];
    const output = await run(
      [
        tool({
          name: 'ids',
          execute: (_params: unknown, _context: unknown, callDetails: unknown) => {
            details.push(callDetails);
            return 'ok';
          },
        }),
      ],
      `await Promise.all([
        tools.ids({ value: "one" }),
        tools.ids({ value: "two" }),
      ]);`,
    );

    expect(output).toContain('2 tool calls: ids×2');
    const callIds = details.map((value) => (value as { toolCall: { callId: string } }).toolCall.callId);
    expect(new Set(callIds).size).toBe(2);
    expect(callIds.every((callId) => /^run_code_bridge_\d+:\d+$/.test(callId))).toBe(true);
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
       return "finished";`,
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
       return "finished";`,
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
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const definition = createRunCodeToolDefinition({
      loggingService: logging(),
      getCwd: () => workspace,
      approvalPolicyRegistry,
    });

    // Mirrors agent-factory: the policy layer wraps each definition, then binds
    // the wrapped list into run_code.
    const wrappedNeedsApproval = wrapNeedsApproval(raw, {
      toolName: raw.name,
      registry: approvalPolicyRegistry,
    });
    const wrapped: ToolRegistry = [
      { ...raw, needsApproval: wrappedNeedsApproval, execute: () => 'policy layer refused this call' },
      definition as unknown as AnyToolDefinition,
    ];
    bindRunCodeRegistry(wrapped);

    const output = String(
      await definition.execute({
        code: 'return await tools.guarded({ value: "x" });',
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
        code: 'console.log("tool count:", Object.keys(tools).length, Object.keys(tools).join(","));',
        timeout_ms: 60_000,
        include_console: true,
      } as never),
    );

    expect(output).toContain('tool count: 1');
    expect(output).toContain('describe');
  });
});
