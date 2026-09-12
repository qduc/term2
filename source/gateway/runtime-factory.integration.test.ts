import { mkdtempSync, rmSync } from 'node:fs';
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
      const session = await factory.create({
        sessionId,
        ownerUserId: sessionId,
        workspaceId: sessionId,
        grantVersion: 1,
        canonicalRoot: workspace,
        access,
      });
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
});
