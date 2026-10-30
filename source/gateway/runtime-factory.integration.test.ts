import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../services/settings/settings-service.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import type { ProviderDefinition } from '../providers/registry.js';
import { createProductionRuntimeFactory } from './runtime-factory.js';
import { mapConversationEvent } from './gateway.js';
import * as sandboxRunnerModule from '../utils/shell/sandbox/shell-sandbox-runner.js';

const roots: string[] = [];
const providerId = 'm1-scripted-provider';
let observedCredential: unknown;
let observedAutoApprove: unknown;
let observedSandbox: unknown;
let observedTools: string[] = [];
let observedRunCodeDescription = '';
let attemptMode: 'direct' | 'nested' | 'subagent' | 'shell' | 'shell-script' | null = null;
let attemptShellCommand = 'printf blocked > shell.txt';
let attemptAllowWrite = false;
let attemptStep = 0;
let observedAttemptInputs: any[] = [];
let observedAttemptEvents: any[] = [];

const provider: ProviderDefinition = {
  id: providerId,
  label: 'M1 scripted provider',
  fetchModels: async () => [{ id: 'm1-scripted-model' }],
  createStreamedModel: (_model, deps) => {
    observedCredential = deps.settingsService.get('agent.openai.apiKey');
    observedAutoApprove = deps.settingsService.get('shell.autoApproveMode');
    observedSandbox = deps.settingsService.get('sandbox.enabled');
    return {
      // The factory must provide credentials to the in-process provider adapter
      // without making host approval/sandbox posture part of the session.

      stream: async function* (request: any) {
        if (attemptMode) {
          observedAttemptInputs.push(request);
          const step = attemptStep++;
          if (attemptMode === 'direct' && step === 0) {
            yield {
              type: 'tool_call' as const,
              id: 'f1-direct',
              name: 'apply_patch',
              arguments: JSON.stringify({
                patch: '*** Begin Patch\\n*** Add File: direct.txt\\n+blocked\\n*** End Patch',
              }),
            };
            return;
          }
          if (attemptMode === 'nested' && step === 0) {
            yield {
              type: 'tool_call' as const,
              id: 'f1-nested',
              name: 'run_code',
              arguments: JSON.stringify({
                code: attemptAllowWrite
                  ? "return await tools.create_file({path: 'write.txt', content: 'written'});"
                  : "return await tools.apply_patch({patch: '*** Begin Patch\\n*** Add File: nested.txt\\n+blocked\\n*** End Patch'});",
                description: 'attempt nested write',
                timeout_ms: 60_000,
              }),
            };
            return;
          }
          if (attemptMode === 'subagent' && step === 0) {
            yield {
              type: 'tool_call' as const,
              id: 'f1-subagent',
              name: 'run_subagent',
              arguments: JSON.stringify({
                role: 'worker',
                task: 'create a file named subagent.txt with content blocked',
              }),
            };
            return;
          }
          if ((attemptMode === 'shell' || attemptMode === 'shell-script') && step === 0) {
            yield {
              type: 'tool_call' as const,
              id: 'f1-shell',
              name: attemptMode === 'shell-script' ? 'run_code' : 'shell',
              arguments: JSON.stringify(
                attemptMode === 'shell-script'
                  ? {
                      code: `return await tools.shell(${JSON.stringify({ command: attemptShellCommand })});`,
                      description: 'scripted sandbox control',
                    }
                  : { command: attemptShellCommand },
              ),
            };
            return;
          }
          // The second provider request belongs to the worker. Deliberately
          // ask for the editor even when it was not advertised: the fixed
          // read-only path must reject the unknown tool, while a dropped
          // readOnly hop would actually create the file.
          if (attemptMode === 'subagent' && step === 1) {
            yield {
              type: 'tool_call' as const,
              id: 'f1-subagent-write',
              name: 'apply_patch',
              arguments: JSON.stringify({
                patch: '*** Begin Patch\\n*** Add File: subagent.txt\\n+blocked\\n*** End Patch',
              }),
            };
            return;
          }
          yield { type: 'completion' as const, responseId: 'f1-attempt-response-' + attemptStep, output: [] };
          return;
        }
        observedTools = (request.tools ?? []).map((tool: any) => tool.name ?? tool.function?.name);
        observedRunCodeDescription = String(
          (request.tools ?? []).find((tool: any) => (tool.name ?? tool.function?.name) === 'run_code')?.description ??
            '',
        );
        yield { type: 'text_delta' as const, text: 'real runtime response' };
        yield {
          type: 'completion' as const,
          responseId: 'm1-response',
          output: [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'real runtime response' }] }],
        };
      },
    };
  },
};

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join('/tmp', prefix)));
  roots.push(root);
  return root;
}

afterEach(() => {
  attemptMode = null;
  attemptShellCommand = 'printf blocked > shell.txt';
  unregisterProvider(providerId);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production gateway runtime factory', () => {
  it('runs a real ConversationService turn and never exposes the fixture broker seam', async () => {
    registerProvider(provider);
    const settings = new SettingsService({
      settingsDir: tempRoot('m1-settings-'),
      disableFilePersistence: true,
      disableLogging: true,
      env: {},
      cli: {},
    });
    settings.set('agent.modelSelection', { model: 'm1-scripted-model', provider: providerId }, { persist: false });
    settings.set('agent.openai.apiKey', 'launcher-secret', { persist: false });
    settings.set('shell.autoApproveMode', 'always', { persist: false });
    settings.set('sandbox.enabled', true, { persist: false });
    const workspace = tempRoot('m1-workspace-');
    const factory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: tempRoot('m1-data-'),
      sandboxAvailable: true,
      policy: { maxActiveTurnMs: 10_000 },
    });
    const events: string[] = [];
    const session = await factory.create(
      {
        sessionId: 'm1-session',
        ownerUserId: 'm1-owner',
        workspaceId: 'm1-workspace',
        grantVersion: 1,
        canonicalRoot: workspace,
        access: 'read',
      },
      {
        eventSink: (event) => {
          events.push(event.type);
        },
      },
    );

    expect(factory.usesRealProviderStack).toBe(true);
    expect(session.resources.providerBroker).toBeUndefined();
    const prepared = await session.prepareMessage('hello', { turnId: 'm1-turn', clientRequestId: 'm1-request' });
    expect(prepared.kind).toBe('prepared');
    if (prepared.kind !== 'prepared') throw new Error('test setup');
    await session.commitMessage(prepared.leaseId);
    await vi.waitFor(() => expect(events, JSON.stringify(events)).toContain('final'));
    expect(observedCredential).toBe('launcher-secret');
    expect(observedAutoApprove).not.toBe('always');
    expect(observedSandbox).toBe(true);
    expect(
      mapConversationEvent({ type: 'final', finalText: 'real runtime response' }, 'm1-turn', 'm1-session')?.type,
    ).toBe('turn_completed');
    await session.dispose();
    await factory.shutdown();
  });

  it('composes read-only and read-write tool surfaces from the gateway grant', async () => {
    registerProvider(provider);
    const settings = new SettingsService({
      settingsDir: tempRoot('f1-settings-'),
      disableFilePersistence: true,
      disableLogging: true,
      env: {},
      cli: {},
    });
    settings.set('agent.modelSelection', { model: 'm1-scripted-model', provider: providerId }, { persist: false });
    const workspace = tempRoot('f1-workspace-');
    let revivedReadOnlyFromAccess: boolean | undefined;
    let captureRevivedAccess = false;
    // Exercise editors through an explicit full-context workflow, not the Bare default.
    settings.set('app.activeProfileId', 'builtin:pair', { persist: false });
    const factory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: tempRoot('f1-data-'),
      sandboxAvailable: true,
      allowWrite: true,
      onAgentClientDeps: ({ readOnly, sessionAccess }) => {
        if (captureRevivedAccess) revivedReadOnlyFromAccess = readOnly && sessionAccess.isReadOnly;
      },
    });
    const run = async (
      sessionId: string,
      access: 'read' | 'read_write',
      settingsSnapshot?: {
        providerId: string;
        modelId: string;
        reasoningEffort: string;
        mode: string;
        effectiveToolPolicy: Record<string, boolean>;
      },
    ) => {
      observedTools = [];
      settings.set(
        'agent.modelSelection',
        { model: 'm1-scripted-model-' + access, provider: providerId },
        { persist: false },
      );
      const session = await factory.create(
        {
          sessionId,
          ownerUserId: sessionId,
          workspaceId: sessionId,
          grantVersion: 1,
          canonicalRoot: workspace,
          access,
        },
        {
          eventSink: (event) => {
            observedAttemptInputs.push({ event });
          },
          ...(settingsSnapshot ? { settingsSnapshot } : {}),
        },
      );
      expect(session.resources.settings.toolPolicy?.allowWrite).toBe(
        settingsSnapshot?.effectiveToolPolicy.allowWrite ?? access === 'read_write',
      );
      const prepared = await session.prepareMessage('inspect tools', { turnId: sessionId, clientRequestId: sessionId });
      if (prepared.kind !== 'prepared') throw new Error('test setup');
      await session.commitMessage(prepared.leaseId);
      await vi.waitFor(() => expect(observedTools.length).toBeGreaterThan(0));
      const names = [...observedTools];
      await session.dispose();
      return names;
    };

    const readOnlyTools = await run('f1-read', 'read');
    expect(readOnlyTools).not.toContain('enter_worktree');
    expect(readOnlyTools).not.toContain('exit_worktree');
    expect(observedRunCodeDescription).not.toContain('tools.apply_patch');
    const readWriteTools = await run('f1-write', 'read_write');
    expect(readWriteTools).toEqual(expect.arrayContaining(['run_code']));
    expect(readWriteTools).toContain('enter_worktree');
    expect(readWriteTools).toContain('exit_worktree');
    expect(observedRunCodeDescription).toContain('tools.create_file');
    captureRevivedAccess = true;
    const revivedReadOnlyTools = await run('f1-revived-read-only', 'read_write', {
      providerId,
      modelId: 'm1-scripted-model',
      reasoningEffort: 'default',
      mode: 'standard',
      effectiveToolPolicy: { allowWrite: false },
    });
    expect(revivedReadOnlyTools).not.toContain('enter_worktree');
    expect(revivedReadOnlyTools).not.toContain('exit_worktree');
    expect(observedRunCodeDescription).not.toContain('tools.apply_patch');
    expect(revivedReadOnlyFromAccess).toBe(true);
    await factory.shutdown();
  });

  it('rejects direct, nested, and subagent writes in a read-only gateway session', async () => {
    registerProvider(provider);
    const settings = new SettingsService({
      settingsDir: tempRoot('f1-attempt-settings-'),
      disableFilePersistence: true,
      disableLogging: true,
      env: {},
      cli: {},
    });
    settings.set('agent.modelSelection', { model: 'm1-attempt-model', provider: providerId }, { persist: false });
    const workspace = tempRoot('f1-attempt-workspace-');
    let composedReadOnly: boolean | undefined;
    // Exercise editors through an explicit full-context workflow, not the Bare default.
    settings.set('app.activeProfileId', 'builtin:pair', { persist: false });
    const factory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: tempRoot('f1-attempt-data-'),
      sandboxAvailable: true,
      allowWrite: true,
      onAgentClientDeps: ({ readOnly, sessionAccess }) => {
        composedReadOnly = readOnly && sessionAccess.isReadOnly;
      },
    });

    const attempt = async (
      mode: 'direct' | 'nested' | 'subagent' | 'shell',
      fileName: string,
      access: 'read' | 'read_write',
    ) => {
      attemptMode = mode;
      attemptAllowWrite = access === 'read_write';
      attemptStep = 0;
      observedAttemptInputs = [];
      observedAttemptEvents = [];
      settings.set('tools.shell.enabled', mode === 'direct' ? false : true, { persist: false });
      settings.set(
        'agent.modelSelection',
        { model: 'm1-attempt-' + mode + '-' + access, provider: providerId },
        { persist: false },
      );
      const session = await factory.create(
        {
          sessionId: 'f1-attempt-' + mode + '-' + access,
          ownerUserId: mode,
          workspaceId: mode,
          grantVersion: 1,
          canonicalRoot: workspace,
          access,
        },
        {
          eventSink: (event) => {
            observedAttemptEvents.push(event);
          },
        },
      );
      const prepared = await session.prepareMessage('attempt write', {
        turnId: 'turn-' + mode,
        clientRequestId: 'request-' + mode,
      });
      if (prepared.kind !== 'prepared') throw new Error('test setup');
      await session.commitMessage(prepared.leaseId);
      if (access === 'read') {
        expect(composedReadOnly, mode + '/' + access).toBe(true);
      }
      await vi.waitFor(() => expect(observedAttemptInputs.length).toBeGreaterThanOrEqual(1));
      if (mode === 'subagent') {
        await vi.waitFor(() => expect(observedAttemptInputs.length).toBeGreaterThanOrEqual(2));
        const workerToolNames = (observedAttemptInputs[1].tools ?? []).map(
          (tool: any) => tool.name ?? tool.function?.name,
        );
        expect(workerToolNames.includes('apply_patch'), mode + '/' + access).toBe(access === 'read_write');
      }
      await vi.waitFor(() => expect(session.status).toBe('idle'));
      const attemptedToolName =
        mode === 'nested'
          ? 'run_code'
          : mode === 'subagent'
          ? 'apply_patch'
          : mode === 'direct'
          ? 'apply_patch'
          : 'shell';
      const resultEvents = observedAttemptEvents.filter(
        (event) =>
          (event.type === 'command_message' || event.type === 'subagent_command_message') &&
          event.message?.toolName === attemptedToolName,
      );
      await session.dispose();
      expect(existsSync(path.join(workspace, fileName)), mode + '/' + access).toBe(access === 'read_write');
      if (access === 'read') {
        expect(resultEvents, mode + '/' + access + ': ' + JSON.stringify(observedAttemptEvents)).not.toHaveLength(0);
        expect(observedAttemptEvents.some((event) => event.type.includes('approval_required'))).toBe(false);
        expect(resultEvents.map((event) => event.message?.failureReason ?? event.message?.output).join('\n')).toMatch(
          /Error|failed|Unknown tool|read-only/i,
        );
      }
    };

    await attempt('direct', 'direct.txt', 'read');
    await attempt('nested', 'nested.txt', 'read');
    await attempt('subagent', 'subagent.txt', 'read');
    const sandboxConfig = vi.fn();
    const realRunner = sandboxRunnerModule.getDefaultShellSandboxRunner();
    const runnerSpy = vi.spyOn(sandboxRunnerModule, 'getDefaultShellSandboxRunner').mockReturnValue({
      ...realRunner,
      availability: async () => ({ type: 'available' as const }),
      wrap: async (_command, options) => {
        sandboxConfig(options.config);
        return { command: 'false' };
      },
    });
    await attempt('shell', 'shell.txt', 'read');
    expect(sandboxConfig).toHaveBeenCalled();
    expect(sandboxConfig.mock.calls[0][0]?.filesystem?.allowWrite ?? []).not.toContain(workspace);
    runnerSpy.mockRestore();
    await attempt('nested', 'write.txt', 'read_write');
    attemptMode = null;
    await factory.shutdown();
  });

  it('enforces real sandbox permissions with a writable production control', async () => {
    registerProvider(provider);
    const settings = new SettingsService({
      settingsDir: tempRoot('sandbox-settings-'),
      disableFilePersistence: true,
      disableLogging: true,
      env: {},
      cli: {},
    });
    settings.set('agent.modelSelection', { model: 'm1-scripted-model', provider: providerId }, { persist: false });
    settings.set('sandbox.enabled', true, { persist: false });
    const workspace = tempRoot('sandbox-workspace-');
    const outside = tempRoot('sandbox-outside-'); // Separate from the shell's writable sandbox temp root.
    writeFileSync(path.join(workspace, 'README.md'), 'SCRIPTED_SANDBOX_READ');
    symlinkSync(outside, path.join(workspace, 'outside-link'), 'dir');
    const factory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: tempRoot('sandbox-runtime-'),
      sandboxAvailable: true,
      allowWrite: true,
    });
    let index = 0;
    const run = async (access: 'read' | 'read_write', command: string, nested = false) => {
      attemptMode = nested ? 'shell-script' : 'shell';
      attemptShellCommand = command;
      attemptStep = 0;
      const events: any[] = [];
      const id = `sandbox-control-${++index}`;
      const session = await factory.create(
        {
          sessionId: id,
          ownerUserId: 'sandbox-owner',
          workspaceId: 'sandbox-workspace',
          grantVersion: 1,
          canonicalRoot: workspace,
          access,
        },
        {
          eventSink: (event) => {
            events.push(event);
          },
        },
      );
      try {
        const admission = await session.prepareMessage('scripted sandbox control', { turnId: id, clientRequestId: id });
        if (admission.kind !== 'prepared') throw new Error('sandbox control was not admitted');
        await session.commitMessage(admission.leaseId);
        await vi.waitFor(() => expect(['idle', 'awaiting_interaction']).toContain(session.status), { timeout: 15_000 });
        if (session.status === 'awaiting_interaction') {
          // Supply the local owner's ordinary approval for these disposable fixture commands.
          await session.service.handleApprovalDecision('y');
        }
        await vi.waitFor(() => expect(session.status).toBe('idle'), { timeout: 15_000 });
        return events
          .filter((event) => event.type === 'command_message')
          .map((event) => event.message?.output ?? event.message?.failureReason ?? '')
          .join('\n');
      } finally {
        await session.dispose();
      }
    };
    try {
      // Positive reads/writes distinguish real sandbox enforcement from an unavailable runner.
      expect(await run('read', 'cat README.md')).toContain('SCRIPTED_SANDBOX_READ');
      await run('read_write', 'printf writable > write-control.txt');
      expect(existsSync(path.join(workspace, 'write-control.txt'))).toBe(true);
      await run('read_write', 'printf nested > nested-control.txt', true);
      expect(existsSync(path.join(workspace, 'nested-control.txt'))).toBe(true);
      expect(await run('read', 'printf blocked > read-marker.txt')).toMatch(
        /read.only|permission|denied|not permitted|exit [1-9]/i,
      );
      expect(await run('read', 'printf blocked > nested-marker.txt', true)).toMatch(
        /read.only|permission|denied|not permitted|exit [1-9]/i,
      );
      expect(existsSync(path.join(workspace, 'read-marker.txt'))).toBe(false);
      expect(existsSync(path.join(workspace, 'nested-marker.txt'))).toBe(false);
      expect(await run('read_write', 'printf blocked > outside-link/outside-marker.txt')).toMatch(
        /read.only|permission|denied|not permitted|exit [1-9]/i,
      );
      expect(existsSync(path.join(outside, 'outside-marker.txt'))).toBe(false);
    } finally {
      await factory.shutdown();
    }
  }, 90_000);
});
