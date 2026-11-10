import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createShellToolDefinition } from '../../../../src/tools/system/shell.js';
import { presentBareShell } from '../../../../src/tools/system/bare-shell.js';
import { createRunCodeToolDefinition } from '../../../../src/delegation/run-code/run-code-tool.js';
import { buildAgentTools, type AgentFactoryDeps } from '../../../../src/app/lib/agent-factory.js';
import { createEditorImpl } from '../../../../src/tools/editor-impl.js';
import { createMockSettingsService } from '../../../helpers/settings-service.mock.js';
import { ExecutionContext } from '../../../../src/tools/execution-context.js';
import { createDirectShellTools } from '../../../../src/app/shell-tools.js';
import { createSourceToolRegistry, executeSourceChild } from '../../../../src/app/source-tools.js';
import { DirectBackgroundTasks } from '../../../../src/session/background.js';
import { directShellTasks } from '../../../../src/session/shell-tasks.js';
import type { ConversationDeps } from '../../../../src/session/types.js';
import type { InteractionDecision, ToolContext, ToolInteractionRequest } from '../../../../src/tools/index.js';
import { ToolApprovalPolicyRegistry } from '../../../../src/session/approval/tool-approval-policy-registry.js';
import { SessionAccessState } from '../../../../src/session/session/session-access-state.js';
import type { ShellSandboxRunner } from '../../../../src/tools/shell/sandbox/sandbox-policy.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId: () => undefined,
  clearCorrelationId() {},
};
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

async function harness(
  options: {
    sandboxRunner?: ShellSandboxRunner;
    approve?: (request: ToolInteractionRequest) => string | undefined;
    owner?: boolean;
    bare?: boolean;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), 'term2-script-shell-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const settings = createMockSettingsService({
    'sandbox.enabled': Boolean(options.sandboxRunner),
    'sandbox.readPolicy': 'strict',
    'shell.autoApproveMode': 'off',
    'shell.timeout': 5000,
    'shell.backgroundTimeout': 5000,
  });
  const executionContext = ExecutionContext.pin(cwd);
  const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
  const tasks = new DirectBackgroundTasks({
    sessionId: 'script-shell-session',
    sink: { accept() {}, publish() {}, failed() {} },
  });
  const shellTools = createDirectShellTools();
  const seen: ToolInteractionRequest[] = [];
  let pending: ((decision: InteractionDecision) => void) | undefined;
  const decide = (answer: string) => {
    const resolve = pending;
    pending = undefined;
    resolve?.(
      answer === 'n' || answer === 'reject'
        ? { kind: 'deny' }
        : { kind: 'allow', ...(answer === 'unsandboxed-once' ? { grant: answer } : {}) },
    );
  };
  const access = new SessionAccessState(settings);
  cleanups.push(async () => {
    await tasks.close();
    shellTools.dispose();
    access.dispose();
  });
  const shell = createShellToolDefinition({
    settingsService: settings,
    loggingService: logger,
    executionContext,
    sessionAccess: access,
    backgroundShellRegistry: shellTools.registry,
    postExecuteDeniedRead: true,
    shellSandboxRunner: options.sandboxRunner,
  });
  const code = createRunCodeToolDefinition({
    loggingService: logger,
    approvalPolicyRegistry,
    executionContext,
    sessionAccess: access,
  });
  const deps: AgentFactoryDeps = {
    settings,
    logger,
    executionContext,
    approvalPolicyRegistry,
    sessionAccess: access,
    withToolInvocation: shellTools.withInvocation,
    executeScriptedTool: executeSourceChild,
    editor: createEditorImpl({ settingsService: settings, loggingService: logger, executionContext }),
    providerId: 'openai',
    serviceTierOverrideForNextRequest: null,
    createMentor: async () => '',
    runSubagent: async () => ({ finalText: '' }),
    runSubagentAsync: async () => ({ runId: 'unused', status: 'running' }),
    getSubagentResult: async () => ({}),
    sendSubagentMessage: () => ({}),
    cancelSubagentRun: () => ({}),
    checkToolInterceptors: async () => null,
  };
  const tools = buildAgentTools({
    toolDefinitions: [options.bare ? presentBareShell(shell) : shell, code],
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps,
  });
  const registry = createSourceToolRegistry(tools, {
    withWorkspace: (operation) => operation(),
    policies: approvalPolicyRegistry,
    settings,
    sessionAccess: access,
    sessionId: 'script-shell-session',
    withAnswer: (_answer, operation) => operation(),
  });
  cleanups.push(() => registry.dispose());
  const context = (signal: AbortSignal): ToolContext => {
    const parent: Parameters<NonNullable<ConversationDeps['shellTasks']>>[0] = {
      turnId: 'test-turn' as Parameters<NonNullable<ConversationDeps['shellTasks']>>[0]['turnId'],
      parentExecutionId: 'test-execution' as Parameters<
        NonNullable<ConversationDeps['shellTasks']>
      >[0]['parentExecutionId'],
      signal,
    };
    return {
      app: {
        workspace: { root: cwd, access: 'read_write', target: 'local' },
        settings: { get: () => undefined, watch: () => () => {} },
        shellTasks: directShellTasks(tasks, parent),
      },
      signal,
      runNested: async () => {
        throw new Error('Unexpected nested run');
      },
      progress() {},
      executeChild: async (_descriptor, operation) => operation(),
      ...(options.owner === false
        ? {}
        : {
            interact: (request: ToolInteractionRequest) =>
              new Promise<InteractionDecision>((resolve) => {
                seen.push(request);
                const finish = (decision: InteractionDecision) => {
                  signal.removeEventListener('abort', abort);
                  pending = undefined;
                  resolve(decision);
                };
                const abort = () => finish({ kind: 'deny' });
                pending = finish;
                signal.addEventListener('abort', abort, { once: true });
                const answer = options.approve?.(request);
                if (answer) decide(answer);
                else if (signal.aborted) abort();
              }),
          }),
    };
  };
  const run = async (script: string, signal = new AbortController().signal, timeout = 3000, inputs?: unknown) => {
    const tool = registry.get('run_code')!;
    try {
      return (
        await tool.execute(
          tool.parse({
            code: script,
            description: 'shell integration',
            timeout_ms: timeout,
            ...(inputs === undefined ? {} : { inputs }),
          }),
          context(signal),
        )
      ).output;
    } catch (error) {
      if (signal.aborted) return String(error);
      throw error;
    } finally {
      tasks.releaseParent('test-turn');
    }
  };
  return { cwd, tools, registry, context, run, seen, decide, isPending: () => Boolean(pending), tasks, settings };
}

async function waitUntil(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error('Expected shell lifecycle event did not occur');
}

function sandboxFixture() {
  const configs: unknown[] = [];
  const runner: ShellSandboxRunner = {
    availability: async () => ({ type: 'available' }),
    wrap: async (command, { config }) => {
      configs.push(config);
      const allowed = config?.filesystem.allowRead?.includes('/outside-script-shell');
      return {
        command: allowed ? command : "printf 'cat: /outside-script-shell/data.txt: Permission denied\\n' >&2; exit 1",
      };
    },
    annotateFailure: (_command, stderr) => stderr,
  };
  return { runner, configs };
}

describe('shell inside run_code through the wrapped tool graph', () => {
  it('reports missing sandbox dependencies and refuses to execute the command', async () => {
    let wrapped = false;
    const f = await harness({
      approve: () => 'y',
      sandboxRunner: {
        availability: async () => ({ type: 'missing_dependency', reason: 'socat not installed' }),
        wrap: async (command) => {
          wrapped = true;
          return { command };
        },
        annotateFailure: (_command, stderr) => stderr,
      },
    });
    const target = join(f.cwd, 'must-not-exist.txt');
    const command = `printf unexpected > ${quote(target)}`;
    const result = await f.run(`return await tools.shell({ command: ${JSON.stringify(command)} });`);
    expect(result).toContain('Shell sandbox unavailable (missing_dependency): socat not installed');
    expect(result).toContain('sandbox="unsandboxed"');
    expect(wrapped).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it('keeps nested JSON and prototype-like input keys as data in the script realm', async () => {
    const f = await harness();
    const inputs = JSON.parse('{"nested":[{"name":"Bob","values":[null,true,3]}],"__proto__":{"polluted":"data"}}');
    const result = await f.run(
      'return [inputs.nested[0].name, inputs.nested[0].values[0] === null, inputs.nested[0].values[1], inputs.nested[0].values[2], Object.hasOwn(inputs, "__proto__"), inputs.__proto__.polluted, Object.getPrototypeOf(inputs).polluted === undefined].join("|");',
      undefined,
      3000,
      inputs,
    );
    expect(result).toContain('Bob|true|true|3|true|data|true');
    expect(f.seen).toEqual([]);
  });

  it('keeps canonical validation and normalization when bare advertises fewer shell options', async () => {
    const graph = await harness({ bare: true });
    const shell = graph.registry.get('shell')!;
    const context = graph.context(new AbortController().signal);
    for (const [index, extra] of [
      { background: null, monitor: null, check_in: null },
      { background: 'false' },
    ].entries()) {
      const file = `normalized-${index}.txt`;
      const output = await shell.execute(shell.parse({ command: `printf canonical > ${file}`, ...extra }), context);
      expect(output.output).toContain('exit 0');
      expect(await readFile(join(graph.cwd, file), 'utf8')).toBe('canonical');
      expect(graph.tasks.list().filter((task) => task.mode === 'background')).toEqual([]);
    }
    for (const extra of [{ background: 'garbage' }, { monitor: { pattern: 5 } }]) {
      const params = { command: 'printf invalid > must-not-exist.txt', ...extra };
      const input = shell.parse(params);
      expect((await shell.approval(input, context)).kind).toBe('none');
      expect((await shell.execute(input, context)).output).toContain('Tool input did not match schema for shell');
      expect(existsSync(join(graph.cwd, 'must-not-exist.txt'))).toBe(false);
    }
  });

  it('preserves bare failure evidence and nested approval denial with a projected shell schema', async () => {
    const graph = await harness({ bare: true, approve: () => 'approve' });
    graph.settings.set('shell.autoApproveMode', 'always');
    const failed = await graph.run(
      'return await tools.shell({command:"printf failure-evidence; exit 7", description:"Run a failing check"});',
    );
    expect(failed).toContain('exit 7');
    expect(failed).toContain('failure-evidence');
    const deniedGraph = await harness({ bare: true, approve: () => 'reject' });
    const denied = await deniedGraph.run(
      'return await tools.shell({command:"printf denied > denied.txt", sandbox:"unsandboxed", description:"Requires approval"});',
    );
    expect(denied).toContain('not approved');
    expect(existsSync(join(deniedGraph.cwd, 'denied.txt'))).toBe(false);
  });

  it('keeps direct shell and executes a scripted shell only after approval', async () => {
    let executedBeforeApproval = false;
    const h = await harness({
      approve: (snapshot) => {
        executedBeforeApproval = existsSync(join(h.cwd, 'approved.txt'));
        expect(snapshot.input).toMatchObject({ sandbox: 'unsandboxed' });
        return 'y';
      },
    });
    expect(h.tools.map((t) => t.name)).toEqual(['shell', 'run_code']);
    const command = `printf approved > ${quote(join(h.cwd, 'approved.txt'))}`;
    const result = await h.run(`return await tools.shell(${JSON.stringify({ command, sandbox: 'unsandboxed' })});`);
    expect(result).toContain('exit 0');
    expect(executedBeforeApproval).toBe(false);
    expect(await readFile(join(h.cwd, 'approved.txt'), 'utf8')).toBe('approved');
    expect(h.seen).toHaveLength(1);
  });

  it('refuses rejected and ownerless approvals without spawning the command', async () => {
    for (const owner of [true, false]) {
      const h = await harness({ owner, approve: () => 'n' });
      const command = `printf forbidden > ${quote(join(h.cwd, 'forbidden.txt'))}`;
      const result = await h.run(
        `try { await tools.shell(${JSON.stringify({
          command,
          sandbox: 'unsandboxed',
        })}); } catch (e) { return e.message; }`,
      );
      expect(result).toMatch(/not approved|requires approval|interaction capability is unavailable/);
      expect(existsSync(join(h.cwd, 'forbidden.txt'))).toBe(false);
    }
  });

  it.each(['allow-once', 'unsandboxed-once', 'n'])(
    'routes sandbox denied-read decision %s without using the root gate',
    async (answer) => {
      const fixture = sandboxFixture();
      const h = await harness({ sandboxRunner: fixture.runner, approve: () => answer });
      const result = await h.run('return await tools.shell({command:"printf recovered"});');
      expect(h.seen).toHaveLength(1);
      expect(h.seen[0]!.presentation?.deniedRead).toMatchObject({ deniedPath: '/outside-script-shell/data.txt' });
      if (answer === 'n') expect(result).not.toContain('recovered');
      else expect(result).toContain('recovered');
      expect(fixture.configs).toHaveLength(answer === 'allow-once' ? 2 : 1);
    },
  );

  it('pauses the work clock while awaiting approval and asks again for the next call', async () => {
    const h = await harness();
    const result = h.run(
      'const args = {command:"printf approved", sandbox:"unsandboxed"}; return [await tools.shell(args), await tools.shell(args)];',
      undefined,
      250,
    );
    await waitUntil(() => h.seen.length === 1);
    await delay(350);
    h.decide('y');
    await waitUntil(() => h.seen.length === 2);
    h.decide('y');
    expect(await result).toContain('approved');
    expect(h.seen[0]!.sourceCallId).not.toBe(h.seen[1]!.sourceCallId);
  });

  it('cancels a pending approval without executing it', async () => {
    const h = await harness();
    const controller = new AbortController();
    const command = `printf forbidden > ${quote(join(h.cwd, 'forbidden.txt'))}`;
    const result = h.run(
      `return await tools.shell(${JSON.stringify({ command, sandbox: 'unsandboxed' })});`,
      controller.signal,
    );
    await waitUntil(() => h.isPending());
    controller.abort();
    await result;
    expect(h.isPending()).toBe(false);
    expect(existsSync(join(h.cwd, 'forbidden.txt'))).toBe(false);
  });

  it.each(['abort', 'deadline'])('terminates a real foreground process on %s', async (reason) => {
    const h = await harness({ approve: () => 'y' });
    const controller = new AbortController();
    const started = join(h.cwd, 'started');
    const done = join(h.cwd, 'done');
    const command = `printf started > ${quote(started)}; sleep 1; printf done > ${quote(done)}`;
    const result = h.run(
      `return await tools.shell(${JSON.stringify({ command, sandbox: 'unsandboxed' })});`,
      controller.signal,
      reason === 'deadline' ? 350 : 3000,
    );
    await waitUntil(() => existsSync(started));
    if (reason === 'abort') controller.abort();
    await result;
    await delay(1100);
    expect(existsSync(done)).toBe(false);
  });

  it('detaches invocation cancellation when a real foreground command is adopted', async () => {
    const h = await harness({ approve: () => 'y' });
    const controller = new AbortController();
    const started = join(h.cwd, 'adopt-started');
    const done = join(h.cwd, 'adopt-done');
    const command = `${process.execPath} -e "require('fs').writeFileSync('${started}','yes'); setTimeout(()=>require('fs').writeFileSync('${done}','yes'),700)"`;
    const running = h.run(
      `return await tools.shell(${JSON.stringify({ command, sandbox: 'unsandboxed' })});`,
      controller.signal,
      3000,
    );
    await waitUntil(() => existsSync(started));
    const task = h.tasks.list().find((task) => task.kind === 'shell' && task.mode === 'foreground');
    expect(task).toBeDefined();
    expect(h.tasks.moveToBackground(task!.taskId).ok).toBe(true);
    expect(String(await running)).toContain(task!.taskId);
    controller.abort();
    await waitUntil(() => existsSync(done));
    await waitUntil(() => h.tasks.get(task!.taskId)?.status === 'completed');
  });

  it('keeps a launched background job alive after script completion and parent abort', async () => {
    const h = await harness({ approve: () => 'y' });
    const controller = new AbortController();
    const done = join(h.cwd, 'background-done');
    const command = `sleep 0.2; printf completed > ${quote(done)}`;
    const result = await h.run(
      `return await tools.shell(${JSON.stringify({ command, sandbox: 'unsandboxed', background: true })});`,
      controller.signal,
    );
    expect(result).toContain('jobId');
    controller.abort();
    await waitUntil(() => existsSync(done));
    expect(await readFile(done, 'utf8')).toBe('completed');
    await waitUntil(() =>
      h.tasks
        .list()
        .filter((task) => task.mode === 'background')
        .every((task) => task.status !== 'running'),
    );
    expect(h.tasks.list().filter((task) => task.mode === 'background')).toMatchObject([{ status: 'completed' }]);
  });
});
