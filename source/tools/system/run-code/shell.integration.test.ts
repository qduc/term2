import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createShellToolDefinition, type BackgroundShellExecutionResult } from '../shell.js';
import { createRunCodeToolDefinition } from './run-code.js';
import { buildAgentTools, type AgentFactoryDeps } from '../../../lib/agent-factory.js';
import { createEditorImpl } from '../../../lib/editor-impl.js';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import { ExecutionContext } from '../../../services/execution-context.js';
import { NestedApprovalOwner, type NestedApprovalSnapshot } from '../../../services/approval/nested-approval-owner.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import { SessionAccessState } from '../../../services/session/session-access-state.js';
import { BackgroundShellRegistry } from '../../../services/shell/background-shell-registry.js';
import { PostExecutePauseCapability } from '../../../services/session/post-execute-pause-capability.js';
import { PostExecutePendingRegistry } from '../../../services/session/post-execute-pending-registry.js';
import type { ShellSandboxRunner } from '../../../utils/shell/sandbox/sandbox-policy.js';

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
    approve?: (snapshot: NestedApprovalSnapshot) => string | undefined;
    owner?: boolean;
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
  const owner = new NestedApprovalOwner('script-shell-session');
  cleanups.push(() => owner.close());
  const seen: NestedApprovalSnapshot[] = [];
  owner.subscribe((snapshot) => {
    if (!snapshot) return;
    seen.push(snapshot);
    const answer = options.approve?.(snapshot);
    if (answer) void owner.decide(snapshot.requestId, { answer });
  });
  const background = new BackgroundShellRegistry<BackgroundShellExecutionResult>();
  cleanups.push(() => background.dispose());
  const access = new SessionAccessState(settings);
  cleanups.push(() => access.dispose());
  const pending = new PostExecutePendingRegistry({ sessionId: 'script-shell-session', epoch: 1 });
  cleanups.push(() => pending.close());
  const postExecutePauseCapability = new PostExecutePauseCapability(pending);
  postExecutePauseCapability.setActiveRunId('test-live-run');
  const shell = createShellToolDefinition({
    settingsService: settings,
    loggingService: logger,
    executionContext,
    sessionAccess: access,
    backgroundShellRegistry: background,
    postExecuteDeniedRead: true,
    shellSandboxRunner: options.sandboxRunner,
  });
  const code = createRunCodeToolDefinition({
    loggingService: logger,
    approvalPolicyRegistry,
    executionContext,
    sessionAccess: access,
    nestedApprovalOwner: options.owner === false ? undefined : owner,
  });
  const deps: AgentFactoryDeps = {
    settings,
    logger,
    executionContext,
    approvalPolicyRegistry,
    sessionAccess: access,
    postExecutePauseCapability,
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
    toolDefinitions: [shell, code],
    resolvedModel: 'gpt-4o',
    shouldUseNativePatchTool: false,
    deps,
  });
  const run = async (script: string, signal?: AbortSignal, timeout = 3000) =>
    String(
      await tools
        .find((t) => t.name === 'run_code')!
        .execute(
          { code: script, description: 'shell integration', timeout_ms: timeout },
          { context: { sessionId: 'script-shell-session' }, signal },
          { toolCall: { callId: 'outer' } },
        ),
    );
  return { cwd, tools, run, owner, seen, pending, background, settings };
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
  it('keeps direct shell and executes a scripted shell only after approval', async () => {
    let executedBeforeApproval = false;
    const h = await harness({
      approve: (snapshot) => {
        executedBeforeApproval = existsSync(join(h.cwd, 'approved.txt'));
        expect(snapshot.preparedArguments).toMatchObject({ sandbox: 'unsandboxed' });
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
      expect(result).toMatch(/not approved|requires approval/);
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
      expect(h.seen[0]!.approval.deniedRead).toMatchObject({ deniedPath: '/outside-script-shell/data.txt' });
      expect(h.pending.snapshot().entries).toHaveLength(0);
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
    await h.owner.decide(h.seen[0]!.requestId, { answer: 'y' });
    await waitUntil(() => h.seen.length === 2);
    await h.owner.decide(h.seen[1]!.requestId, { answer: 'y' });
    expect(await result).toContain('approved');
    expect(h.seen[0]!.nestedCallId).not.toBe(h.seen[1]!.nestedCallId);
  });

  it('cancels a pending approval without executing it', async () => {
    const h = await harness();
    const controller = new AbortController();
    const command = `printf forbidden > ${quote(join(h.cwd, 'forbidden.txt'))}`;
    const result = h.run(
      `return await tools.shell(${JSON.stringify({ command, sandbox: 'unsandboxed' })});`,
      controller.signal,
    );
    await waitUntil(() => Boolean(h.owner.getSnapshot()));
    controller.abort();
    await result;
    expect(h.owner.getSnapshot()).toBeNull();
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
    await waitUntil(() => h.background.list().every((job) => job.status !== 'running'));
    expect(h.background.list()).toMatchObject([{ status: 'completed' }]);
  });
});
