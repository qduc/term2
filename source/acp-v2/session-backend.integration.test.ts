import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpV2Agent } from './agent.js';
import { createAcpV2SessionBackend } from './session-backend.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import type { ProviderDefinition } from '../providers/registry.js';
import { createProductionRuntimeFactory } from '../gateway/runtime-factory.js';
import * as sandboxRunnerModule from '../utils/shell/sandbox/shell-sandbox-runner.js';

const providerId = 'acp-m1-integration-provider';
const roots: string[] = [];
let providerCall = 0;
let releaseCancel: (() => void) | undefined;
let writeIssued = false;
const providerRequests: string[] = [];

const provider: ProviderDefinition = {
  id: providerId,
  label: 'ACP M1 integration provider',
  fetchModels: async () => [{ id: 'acp-m1-model' }],
  createStreamedModel: () => ({
    stream: async function* (request: any) {
      const call = providerCall++;
      const requestText = JSON.stringify(request);
      providerRequests.push(requestText);
      if (requestText.includes('cancel this')) {
        await new Promise<void>((resolve) => {
          releaseCancel = resolve;
          if (request.signal) request.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'completion' as const, responseId: `acp-cancel-${call}`, output: [] };
        return;
      }
      if (requestText.includes('write this') && !writeIssued) {
        writeIssued = true;
        yield {
          type: 'tool_call' as const,
          id: 'acp-write-1',
          name: 'apply_patch',
          arguments: JSON.stringify({ patch: '*** Begin Patch\n*** Add File: blocked.txt\n+blocked\n*** End Patch' }),
        };
        return;
      }
      if (requestText.includes('write this')) {
        yield { type: 'text_delta' as const, text: 'denied' };
        yield { type: 'completion' as const, responseId: `acp-write-denied-${call}`, output: [] };
        return;
      }
      if (requestText.includes('read the file') && call === 0) {
        yield {
          type: 'tool_call' as const,
          id: 'acp-read-1',
          name: 'read_file',
          arguments: JSON.stringify({ path: path.join(process.env.ACP_M1_WORKSPACE ?? process.cwd(), 'readme.txt') }),
        };
        return;
      }
      if (requestText.includes('read the file')) {
        yield {
          type: 'completion' as const,
          responseId: 'acp-response-1',
          output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'read complete' }] }],
        };
        return;
      }
      yield { type: 'completion' as const, responseId: `acp-response-${call}`, output: [] };
    },
  }),
};

const connectOverNdJson = async (
  agent: acp.AgentApp,
  client: acp.ClientApp,
  run: (context: acp.ClientContext) => Promise<void>,
): Promise<void> => {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  const agentConnection = agent.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
  try {
    await client.connectWith(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable), run);
  } finally {
    agentConnection.close();
    await agentConnection.closed;
  }
};

afterEach(() => {
  unregisterProvider(providerId);
  providerCall = 0;
  releaseCancel = undefined;
  writeIssued = false;
  providerRequests.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ACP v2 production backend integration', () => {
  it('runs, cancels, and fail-closed-denies a real RuntimeFactory session', async () => {
    registerProvider(provider);
    const workspace = mkdtempSync('/tmp/acp-m1-workspace-');
    const settingsDir = mkdtempSync('/tmp/acp-m1-settings-');
    const dataDir = mkdtempSync('/tmp/acp-m1-data-');
    roots.push(workspace, settingsDir, dataDir);
    writeFileSync(path.join(workspace, 'readme.txt'), 'hello');
    process.env.ACP_M1_WORKSPACE = workspace;
    process.env.TERM2_CONVERSATIONS_DIR = path.join(dataDir, 'conversations');
    process.env.TERM2_TEST_DB_DIR = path.join(dataDir, 'conversations');
    const settings = new SettingsService({
      settingsDir,
      disableFilePersistence: true,
      disableLogging: true,
      env: {},
      cli: {},
    });
    settings.set('agent.provider', providerId, { persist: false });
    settings.set('agent.model', 'acp-m1-model', { persist: false });
    settings.set('agent.openai.apiKey', 'test-key', { persist: false });
    const runtimeFactory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: dataDir,
      sandboxAvailable: true,
      policy: { maxActiveTurnMs: 30_000 },
    });
    const backend = createAcpV2SessionBackend({ runtimeFactory });
    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'acp-m1-integration-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });
    const agent = createAcpV2Agent({ backend, logger: { error: vi.fn() }, version: 'test' });

    try {
      await connectOverNdJson(agent, client, async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: 'integration-client', version: '1' },
        });
        const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'read the file' }],
        });
        await vi.waitFor(() => {
          expect(updates).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ update: { sessionUpdate: 'state_update', state: 'running' } }),
              expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }) }),
              expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'tool_call' }) }),
              expect.objectContaining({
                update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
              }),
            ]),
          );
        });

        await context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'cancel this' }],
        });
        await vi.waitFor(() =>
          expect(updates.at(-1)?.update).toEqual({ sessionUpdate: 'state_update', state: 'running' }),
        );
        releaseCancel?.();
        await context.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
        await vi.waitFor(() =>
          expect(updates.at(-1)?.update).toEqual({
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'cancelled',
          }),
        );

        await context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'write this' }],
        });
        await vi.waitFor(() =>
          expect(updates.at(-1)?.update).toEqual({
            sessionUpdate: 'state_update',
            state: 'idle',
            stopReason: 'end_turn',
          }),
        );
        expect(existsSync(path.join(workspace, 'blocked.txt'))).toBe(false);
        await context.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
        const listed = await context.request(acp.methods.agent.session.list, { cwd: workspace });
        expect(listed.sessions.some((entry) => entry.sessionId === created.sessionId)).toBe(true);
        await context.request(acp.methods.agent.session.resume, {
          sessionId: created.sessionId,
          cwd: workspace,
          replayFrom: { type: 'start' },
        });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'after resume' }],
        });
        await vi.waitFor(() => {
          const resumedRequest = providerRequests.at(-1) ?? '';
          expect(resumedRequest).toContain('read the file');
          expect(resumedRequest).toContain('read complete');
        });
      });
    } finally {
      delete process.env.ACP_M1_WORKSPACE;
      delete process.env.TERM2_CONVERSATIONS_DIR;
      delete process.env.TERM2_TEST_DB_DIR;
      await runtimeFactory.shutdown();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// M3: the client permission round trip.
//
// These tests drive the production stack the launcher uses
// (`createProductionRuntimeFactory({ allowWrite: true })`, the same wiring as
// `source/acp-v2/serve.ts`) with a scripted provider and the real SDK stream
// pair. The approval trigger is `shell` with `sandbox: 'unsandboxed'`, which
// `source/tools/system/shell.ts` (needsApproval) makes unconditionally
// approval-required and which is directly callable in a production session.
// ---------------------------------------------------------------------------

const bridgeProviderId = 'acp-m3-integration-provider';

type PermissionHandler = (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;

type BridgeSession = {
  workspace: string;
  workspaceFile: string;
  escapeFile: string;
  sessionId: string;
  updates: acp.UpdateSessionNotification[];
  permissionRequests: acp.RequestPermissionRequest[];
  prompt: () => Promise<void>;
  waitForPermissionRequest: (timeoutMs: number) => Promise<boolean>;
  waitForTerminal: (timeoutMs: number) => Promise<string>;
  cancel: () => Promise<void>;
  unwind: () => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const never = <T>(): Promise<T> => new Promise<T>(() => {});

const withBridgeSession = async (
  options: {
    command: (paths: { workspaceFile: string; escapeFile: string }) => string;
    sandboxRunner?: boolean;
    permission?: PermissionHandler;
  },
  body: (session: BridgeSession) => Promise<void>,
): Promise<void> => {
  const workspace = mkdtempSync('/tmp/acp-m3-workspace-');
  const escapeDir = mkdtempSync('/tmp/acp-m3-escape-');
  const settingsDir = mkdtempSync('/tmp/acp-m3-settings-');
  const dataDir = mkdtempSync('/tmp/acp-m3-data-');
  roots.push(workspace, escapeDir, settingsDir, dataDir);
  const workspaceFile = path.join(workspace, 'probe.txt');
  const escapeFile = path.join(escapeDir, 'escaped.txt');
  process.env.TERM2_CONVERSATIONS_DIR = path.join(dataDir, 'conversations');
  process.env.TERM2_TEST_DB_DIR = path.join(dataDir, 'conversations');

  let turn = 0;
  const provider: ProviderDefinition = {
    id: bridgeProviderId,
    label: 'ACP M3 permission provider',
    fetchModels: async () => [{ id: 'acp-m3-model' }],
    createStreamedModel: () => ({
      stream: async function* () {
        const current = turn++;
        if (current === 0) {
          yield {
            type: 'tool_call' as const,
            id: 'acp-m3-shell-1',
            name: 'shell',
            arguments: JSON.stringify({
              command: options.command({ workspaceFile, escapeFile }),
              sandbox: 'unsandboxed',
            }),
          };
          return;
        }
        yield { type: 'text_delta' as const, text: 'done' };
        yield { type: 'completion' as const, responseId: `acp-m3-${current}`, output: [] };
      },
    }),
  };
  registerProvider(provider);

  const settings = new SettingsService({
    settingsDir,
    disableFilePersistence: true,
    disableLogging: true,
    env: {},
    cli: {},
  });
  settings.set('agent.provider', bridgeProviderId, { persist: false });
  settings.set('agent.model', 'acp-m3-model', { persist: false });
  settings.set('agent.openai.apiKey', 'test-key', { persist: false });
  const runtimeFactory = createProductionRuntimeFactory({
    settingsAuthority: settings,
    tmpDir: dataDir,
    sandboxAvailable: true,
    allowWrite: true,
    policy: { maxActiveTurnMs: 30_000 },
  });
  const backend = createAcpV2SessionBackend({ runtimeFactory });
  const realRunner = options.sandboxRunner ? sandboxRunnerModule.getDefaultShellSandboxRunner() : undefined;
  const runnerSpy = realRunner
    ? vi.spyOn(sandboxRunnerModule, 'getDefaultShellSandboxRunner').mockReturnValue({
        ...realRunner,
        availability: async () => ({ type: 'available' as const }),
        wrap: async (command) => ({ command }),
      })
    : undefined;

  const updates: acp.UpdateSessionNotification[] = [];
  const permissionRequests: acp.RequestPermissionRequest[] = [];
  const notifying = acp
    .client({ name: 'acp-m3-integration-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  const client = options.permission
    ? notifying.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        permissionRequests.push(params);
        return await options.permission!(params);
      })
    : notifying;
  const agent = createAcpV2Agent({ backend, logger: { error: vi.fn() }, version: 'test' });

  const terminalStopReason = (): string | undefined => {
    for (let index = updates.length - 1; index >= 0; index -= 1) {
      const update = updates[index]!.update as { sessionUpdate?: string; state?: string; stopReason?: string };
      if (update.sessionUpdate === 'state_update' && update.state === 'idle') return String(update.stopReason);
    }
    return undefined;
  };

  try {
    await connectOverNdJson(agent, client, async (context) => {
      await context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        info: { name: 'acp-m3-integration-client', version: '1' },
      });
      const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
      const session: BridgeSession = {
        workspace,
        workspaceFile,
        escapeFile,
        sessionId: created.sessionId,
        updates,
        permissionRequests,
        prompt: async () => {
          await context.request(acp.methods.agent.session.prompt, {
            sessionId: created.sessionId,
            prompt: [{ type: 'text', text: 'run the tool' }],
          });
        },
        waitForPermissionRequest: async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            if (permissionRequests.length > 0) return true;
            await sleep(50);
          }
          return false;
        },
        waitForTerminal: async (timeoutMs) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const stopReason = terminalStopReason();
            if (stopReason) return stopReason;
            await sleep(50);
          }
          return 'timeout';
        },
        cancel: async () => {
          await context.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
        },
        // Bounded on purpose: a turn parked on an approval that is never
        // resolved does not settle, so `session/close` (which waits for the
        // running prompt) may never answer. Cleanup must not turn a failing
        // assertion into a test timeout.
        unwind: async () => {
          try {
            await context.notify(acp.methods.agent.session.cancel, { sessionId: created.sessionId });
          } catch {
            // The connection may already be gone.
          }
          try {
            await Promise.race([
              context.request(acp.methods.agent.session.close, { sessionId: created.sessionId }),
              sleep(2_000),
            ]);
          } catch {
            // Closing a stuck session is best effort.
          }
        },
      };
      await body(session);
    });
  } finally {
    runnerSpy?.mockRestore();
    unregisterProvider(bridgeProviderId);
    delete process.env.TERM2_CONVERSATIONS_DIR;
    delete process.env.TERM2_TEST_DB_DIR;
    await Promise.race([runtimeFactory.shutdown(), sleep(5_000)]);
  }
};

describe('ACP v2 permission bridge integration', () => {
  // DEFECT: the client never receives a permission request. `mapEvent` reads the
  // pending interaction from `turn.session.resources.runtime`, which
  // `composeGatewaySession` never sets for a session built by
  // `createProductionRuntimeFactory` (see the note on `createRuntime` in
  // source/gateway/worker-boundary.ts); the bridge therefore always falls back
  // to the M1 denial and no client allow can ever be honored.
  it('asks the client for permission and runs the approved shell call', async () => {
    await withBridgeSession(
      {
        command: () => 'echo written > probe.txt',
        sandboxRunner: true,
        permission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
      },
      async (session) => {
        // The command writes inside the session workspace, so a run proves the
        // approved call executed.
        await session.prompt();
        const arrived = await session.waitForPermissionRequest(5_000);
        expect(
          arrived,
          'DEFECT: no session/request_permission reached the client, so the client allow is never honored',
        ).toBe(true);
        expect(session.permissionRequests[0]!.options.map((option) => option.optionId)).not.toContain(
          'unsandboxed-once',
        );
        expect(await session.waitForTerminal(5_000)).toBe('end_turn');
        expect(existsSync(session.workspaceFile)).toBe(true);
        expect(session.updates).not.toContainEqual(
          expect.objectContaining({
            update: expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }),
          }),
        );
        await session.unwind();
      },
    );
  });

  // DEFECT: same missing snapshot as above; on top of that the denial path never
  // reaches a terminal state_update (`session.abort` on a turn parked on an
  // approval it cannot resolve), so the prompt hangs.
  it('a client rejection denies the call and still ends the turn', async () => {
    await withBridgeSession(
      {
        command: ({ workspaceFile }) => 'echo written > ' + workspaceFile,
        permission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
      async (session) => {
        await session.prompt();
        const terminal = await session.waitForTerminal(5_000);
        expect(session.updates).toContainEqual(
          expect.objectContaining({
            update: expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }),
          }),
        );
        expect(existsSync(session.workspaceFile)).toBe(false);
        expect(terminal, 'DEFECT: a denied approval never reaches a terminal state_update').toBe('end_turn');
        await session.unwind();
      },
    );
  });

  // DEFECT: unreachable while no permission request reaches the client; the
  // cancel behaviour itself is asserted for the fixed bridge.
  it('session/cancel while the permission request is pending cancels the turn', async () => {
    await withBridgeSession(
      {
        command: ({ workspaceFile }) => 'echo written > ' + workspaceFile,
        permission: () => never<acp.RequestPermissionResponse>(),
      },
      async (session) => {
        await session.prompt();
        const arrived = await session.waitForPermissionRequest(5_000);
        if (arrived) {
          await session.cancel();
          expect(await session.waitForTerminal(5_000)).toBe('cancelled');
          expect(existsSync(session.workspaceFile)).toBe(false);
        }
        await session.unwind();
        expect(arrived, 'DEFECT: no pending permission request to cancel').toBe(true);
      },
    );
  });

  // Addendum 17: the default (no client handler) denial path must still end the
  // turn. `session.abort` on a turn parked on an unresolved approval never
  // settles, so the launcher leaves the client waiting forever -- this also
  // affects the M1 path already merged on main.
  it('a fallback-denied approval still ends the turn', async () => {
    await withBridgeSession({ command: ({ workspaceFile }) => 'echo written > ' + workspaceFile }, async (session) => {
      await session.prompt();
      const terminal = await session.waitForTerminal(5_000);
      await session.unwind();
      // Observed while this test was written: state_update running -> tool_call
      // pending -> two `tool_call_update` failed updates carrying the fallback
      // reason, and no terminal state_update at all.
      expect(JSON.stringify(session.updates)).toContain('Approval is not yet supported over ACP.');
      expect(JSON.stringify(session.updates)).toContain('"status":"failed"');
      expect(existsSync(session.workspaceFile)).toBe(false);
      expect(terminal, 'DEFECT: a fallback-denied approval never reaches a terminal state_update').toBe('end_turn');
    });
  });

  // Addendum 18: what an allow actually does for `sandbox: 'unsandboxed'`. The
  // command escapes the session workspace, so the asserted policy is that an
  // ACP allow must not turn into an unsandboxed escape. `createProductionRuntimeFactory`
  // here is configured exactly like `term2 acp` (allowWrite: true, no
  // allowUnsandboxed, so the snapshot keeps the launcher's false).
  it('an allowed unsandboxed shell call never escapes the workspace', async () => {
    await withBridgeSession(
      {
        command: ({ escapeFile }) => 'echo escaped > ' + escapeFile,
        permission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
      },
      async (session) => {
        await session.prompt();
        const arrived = await session.waitForPermissionRequest(5_000);
        expect(
          arrived,
          'DEFECT: no session/request_permission reached the client, so the allow/escape outcome cannot be observed',
        ).toBe(true);
        const offered = session.permissionRequests[0]!.options.map((option) => option.optionId);
        expect(offered).not.toContain('unsandboxed-once');
        expect(offered).not.toContain('allow-remember');
        expect(await session.waitForTerminal(5_000)).toBe('end_turn');
        await session.unwind();
        expect(existsSync(session.escapeFile)).toBe(false);
        expect(existsSync(session.workspaceFile)).toBe(false);
      },
    );
  });
});
