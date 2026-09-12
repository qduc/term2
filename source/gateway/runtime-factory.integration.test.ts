import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '../services/settings/settings-service.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import type { ProviderDefinition } from '../providers/registry.js';
import { createProductionRuntimeFactory } from './runtime-factory.js';
import { mapConversationEvent } from './gateway.js';

const roots: string[] = [];
const providerId = 'm1-scripted-provider';
let observedCredential: unknown;
let observedAutoApprove: unknown;
let observedSandbox: unknown;
let observedTools: string[] = [];
let observedRunCodeDescription = '';
let attemptMode: 'direct' | 'nested' | 'subagent' | null = null;
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
  const root = mkdtempSync(path.join('/tmp', prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
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
    settings.set('agent.provider', providerId, { persist: false });
    settings.set('agent.model', 'm1-scripted-model', { persist: false });
    settings.set('agent.openai.apiKey', 'launcher-secret', { persist: false });
    settings.set('shell.autoApproveMode', 'always', { persist: false });
    settings.set('sandbox.enabled', false, { persist: false });
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
    settings.set('agent.provider', providerId, { persist: false });
    settings.set('agent.model', 'm1-scripted-model', { persist: false });
    const workspace = tempRoot('f1-workspace-');
    const factory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: tempRoot('f1-data-'),
      sandboxAvailable: true,
      allowWrite: true,
    });
    const run = async (sessionId: string, access: 'read' | 'read_write') => {
      settings.set('agent.model', 'm1-scripted-model-' + access, { persist: false });
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
        },
      );
      expect(session.resources.settings.toolPolicy?.allowWrite).toBe(access === 'read_write');
      const prepared = await session.prepareMessage('inspect tools', { turnId: sessionId, clientRequestId: sessionId });
      if (prepared.kind !== 'prepared') throw new Error('test setup');
      await session.commitMessage(prepared.leaseId);
      await vi.waitFor(() => expect(observedTools.length).toBeGreaterThan(0));
      const names = [...observedTools];
      await session.dispose();
      return names;
    };

    const readOnlyTools = await run('f1-read', 'read');
    expect(readOnlyTools).not.toEqual(expect.arrayContaining(['apply_patch', 'create_file', 'search_replace']));
    expect(observedRunCodeDescription).not.toContain('tools.apply_patch');
    const readWriteTools = await run('f1-write', 'read_write');
    expect(readWriteTools).toEqual(expect.arrayContaining(['run_code']));
    expect(observedRunCodeDescription).toContain('tools.create_file');
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
    settings.set('agent.provider', providerId, { persist: false });
    const workspace = tempRoot('f1-attempt-workspace-');
    const factory = createProductionRuntimeFactory({
      settingsAuthority: settings,
      tmpDir: tempRoot('f1-attempt-data-'),
      sandboxAvailable: true,
      allowWrite: true,
    });

    const attempt = async (mode: 'direct' | 'nested' | 'subagent', fileName: string, access: 'read' | 'read_write') => {
      attemptMode = mode;
      attemptAllowWrite = access === 'read_write';
      attemptStep = 0;
      observedAttemptInputs = [];
      observedAttemptEvents = [];
      settings.set('tools.shell.enabled', mode === 'direct' ? false : true, { persist: false });
      settings.set('agent.model', 'm1-attempt-' + mode + '-' + access, { persist: false });
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
      await vi.waitFor(() => expect(observedAttemptInputs.length).toBeGreaterThanOrEqual(1));
      if (mode === 'subagent') {
        await vi.waitFor(() => expect(observedAttemptInputs.length).toBeGreaterThanOrEqual(2));
        const workerToolNames = (observedAttemptInputs[1].tools ?? []).map(
          (tool: any) => tool.name ?? tool.function?.name,
        );
        expect(workerToolNames.includes('apply_patch'), mode + '/' + access).toBe(access === 'read_write');
      }
      await vi.waitFor(() => expect(session.status).toBe('idle'));
      await session.dispose();
      expect(existsSync(path.join(workspace, fileName)), mode + '/' + access).toBe(access === 'read_write');
      if (access === 'read') {
        expect(observedAttemptEvents.some((event) => event.type.includes('approval_required'))).toBe(false);
        expect(JSON.stringify(observedAttemptEvents), mode + '/' + access).toMatch(/Error|failed|Unknown tool/);
      }
    };

    await attempt('direct', 'direct.txt', 'read');
    await attempt('nested', 'nested.txt', 'read');
    await attempt('subagent', 'subagent.txt', 'read');
    await attempt('nested', 'write.txt', 'read_write');
    attemptMode = null;
    await factory.shutdown();
  });
});
