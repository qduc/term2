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

const providerId = 'acp-m1-integration-provider';
const roots: string[] = [];
let providerCall = 0;
let releaseCancel: (() => void) | undefined;
let writeIssued = false;

const provider: ProviderDefinition = {
  id: providerId,
  label: 'ACP M1 integration provider',
  fetchModels: async () => [{ id: 'acp-m1-model' }],
  createStreamedModel: () => ({
    stream: async function* (request: any) {
      const call = providerCall++;
      const requestText = JSON.stringify(request);
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
        yield { type: 'text_delta' as const, text: 'read complete' };
        yield { type: 'completion' as const, responseId: 'acp-response-1', output: [] };
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
          expect(updates).toContainEqual(
            expect.objectContaining({
              update: expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }),
            }),
          ),
        );
        expect(existsSync(path.join(workspace, 'blocked.txt'))).toBe(false);
        await context.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
        const listed = await context.request(acp.methods.agent.session.list, { cwd: workspace });
        // The existing RuntimeFactory composition persists to its own conversation
        // logger path; this assertion documents the current gap until that path
        // is made injectable by the runtime composition.
        expect(listed.sessions.some((entry) => entry.sessionId === created.sessionId)).toBe(false);
      });
    } finally {
      delete process.env.ACP_M1_WORKSPACE;
      delete process.env.TERM2_CONVERSATIONS_DIR;
      delete process.env.TERM2_TEST_DB_DIR;
      await runtimeFactory.shutdown();
    }
  }, 30_000);
});
