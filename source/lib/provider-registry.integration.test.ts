import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { ConversationService } from '../services/conversation/conversation-service.js';
import { createCustomProviderModelProvider } from '../providers/openai-compatible.provider.js';
import {
  createProviderRegistry,
  getProvider,
  upsertProvider,
  unregisterProvider,
  type ProviderDefinition,
} from '../providers/registry.js';

async function startEndpoint(label: string, reject = false) {
  const requests: Array<{ method: string | undefined; path: string | undefined; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method, path: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (reject) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'SYNTHETIC_SCOPED_REJECTION' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end(
      `data: ${JSON.stringify({
        id: `${label}-response`,
        object: 'chat.completion.chunk',
        model: 'fixture-model',
        choices: [{ index: 0, delta: { content: `SYNTHETIC_${label}` }, finish_reason: 'stop' }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing synthetic fixture address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolve())),
      );
    },
  };
}

function definition(id: string, baseUrl: string, chaining: boolean): ProviderDefinition {
  return {
    id,
    label: id,
    capabilities: { supportsConversationChaining: chaining },
    fetchModels: async () => [],
    createStreamedModel(model, deps) {
      // Exercise the real HTTP adapter, not a fake StreamedModel or fetch stub.
      return createCustomProviderModelProvider(
        { name: id, type: 'openai-compatible', baseUrl, apiKey: 'synthetic-fixture-key' },
        { defaultModel: model, settingsService: deps.settingsService, loggingService: deps.loggingService },
      ).getStreamedModel(model);
    },
  };
}

// A conflicting global ID is essential: capability lookup and model construction
// must use the same client-owned definition, even when a global alternative exists.
it.each(['override', 'scoped-only', 'global-control', 'scoped-rejection'] as const)(
  'routes a public conversation through the actual provider socket: %s',
  async (scenario) => {
    const id = `registry-http-fixture-${scenario}`;
    const globalEndpoint = await startEndpoint('GLOBAL');
    const scopedEndpoint = await startEndpoint('SCOPED', scenario === 'scoped-rejection');
    const global = definition(id, globalEndpoint.baseUrl, false);
    const scoped = definition(id, scopedEndpoint.baseUrl, true);
    const registry = createProviderRegistry();
    registry.upsertProvider(scoped);
    if (scenario !== 'scoped-only') upsertProvider(global);
    const hasScope = scenario !== 'global-control';
    const settings = new SettingsService({
      disableLogging: true,
      disableFilePersistence: true,
      cli: {
        agent: {
          modelSelection: { provider: id, model: 'fixture-model' },
          retryAttempts: 0,
          contextCompaction: { enabled: false },
          sessionRollover: { enabled: false },
          runBudget: { escalation: 'disabled' },
        } as never,
      },
    });
    const logger = new LoggingService({ disableLogging: true });
    const context = new SessionContextService();
    const ownership = new ToolOwnershipRegistry();
    const client = new AgentClient({
      selection: { provider: id, model: 'fixture-model' },
      agentOverride: {
        name: 'Registry HTTP fixture',
        model: 'fixture-model',
        instructions: 'Synthetic fixture',
        tools: [],
      },
      toolOwnership: ownership,
      deps: { settings, logger, sessionContextService: context, ...(hasScope ? { providerRegistry: registry } : {}) },
    });
    const service = new ConversationService({
      agentClient: client,
      toolOwnership: ownership,
      sessionId: `registry-http-${scenario}`,
      deps: { settingsService: settings, logger, sessionContextService: context },
    });
    try {
      // Prove synthetic routing before admitting any request. No built-in ID is selected.
      expect(getProvider(id)).toBe(scenario === 'scoped-only' ? undefined : global);
      expect(getProvider(id, registry)).toBe(scoped);
      expect(client.supportsConversationChaining()).toBe(hasScope);
      if (scenario === 'scoped-rejection') {
        await expect(service.sendMessage('SYNTHETIC_REGISTRY_HTTP_PROBE')).rejects.toThrow(
          'SYNTHETIC_SCOPED_REJECTION',
        );
      } else {
        const result = await service.sendMessage('SYNTHETIC_REGISTRY_HTTP_PROBE');
        expect(result).toMatchObject({ type: 'response', finalText: `SYNTHETIC_${hasScope ? 'SCOPED' : 'GLOBAL'}` });
      }
      const selected = hasScope ? scopedEndpoint : globalEndpoint;
      const unselected = hasScope ? globalEndpoint : scopedEndpoint;
      expect(unselected.requests).toEqual([]);
      expect(selected.requests).toHaveLength(1);
      expect(selected.requests[0]).toMatchObject({
        method: 'POST',
        path: '/v1/chat/completions',
        body: {
          model: 'fixture-model',
          stream: true,
          messages: expect.arrayContaining([
            { role: 'user', content: [{ type: 'text', text: 'SYNTHETIC_REGISTRY_HTTP_PROBE' }] },
          ]),
        },
      });
    } finally {
      service.dispose();
      await client.dispose();
      unregisterProvider(id);
      await Promise.all([globalEndpoint.close(), scopedEndpoint.close()]);
    }
  },
);
