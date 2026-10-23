import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentChatService } from './agent-chat-service.js';
import { AgentClient } from './agent-client.js';
import { SettingsService } from '../services/settings/settings-service.js';
import { LoggingService } from '../services/logging/logging-service.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { SessionTrafficContext } from '../services/service-interfaces.js';
import type { AgentConfiguration } from './agent-configuration.js';
import { createOpenAICompatibleProviderDefinition } from '../providers/openai-compatible.provider.js';
import { getProvider, unregisterProvider, upsertProvider } from '../providers/registry.js';
import { createOpencodeSessionInjector } from '../providers/opencode-session.js';
import {
  ApplicationRunLoop,
  toModelTools,
  type ApplicationAgent,
} from '../services/agent-runtime/application-run-loop.js';
import { LocalContextCompactor } from '../services/agent-runtime/context-compaction/local-context-compactor.js';
import { CONTEXT_COMPACTION_INSTRUCTIONS, CONTEXT_COMPACTION_REQUEST } from '../prompts/context-compaction.js';
import type { ProviderInputItem } from '../contracts/provider-input.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

const provider = 'compaction-prefix-fixture';
const summary = '## Current goal and success criteria\nContinue editing the fixture. The old tool completed once.';
const history = (): ProviderInputItem[] => [
  { type: 'message', role: 'user', content: 'Keep the original constraint EXACTLY.' },
  { type: 'function_call', callId: 'old-call', name: 'fixture_write', arguments: '{"path":"already-written"}' },
  { type: 'function_call_result', callId: 'old-call', name: 'fixture_write', output: 'old output '.repeat(6_000) },
  { type: 'message', role: 'assistant', content: 'The old edit completed.' },
  { type: 'message', role: 'user', content: 'Next task.' },
  { type: 'function_call', callId: 'new-call', name: 'fixture_write', arguments: '{"path":"recent"}' },
  { type: 'function_call_result', callId: 'new-call', name: 'fixture_write', output: 'recent output' },
  { type: 'message', role: 'assistant', content: 'Latest answer.' },
  { type: 'message', role: 'user', content: 'Continue.' },
];

describe('prefix-preserving context compaction over a real provider socket', () => {
  let server: Server;
  let chat: AgentChatService;
  let settings: ISettingsService;
  let logger: ILoggingService;
  let agent: ApplicationAgent;
  let requests: Array<Record<string, any>>;
  let requestHeaders: IncomingHttpHeaders[];
  let responseMode: 'summary' | 'tool' | 'empty' | 'error';
  let executions: number;

  beforeEach(async () => {
    requests = [];
    requestHeaders = [];
    responseMode = 'summary';
    executions = 0;
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      requestHeaders.push(req.headers);
      if (responseMode === 'error') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Injected summary rejection' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta =
        responseMode === 'tool'
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'unexpected-call',
                  type: 'function',
                  function: { name: 'fixture_write', arguments: '{"path":"must-not-exist"}' },
                },
              ],
            }
          : { content: responseMode === 'empty' ? '' : summary };
      res.end(
        `data: ${JSON.stringify({
          id: 'summary-response',
          object: 'chat.completion.chunk',
          model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason: responseMode === 'tool' ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 16_000, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 15_000 } },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture socket');
    const config = {
      id: provider,
      name: provider,
      type: 'openai-compatible' as const,
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'fixture-key',
    };
    upsertProvider(createOpenAICompatibleProviderDefinition({ ...config, name: provider }));
    const values: Record<string, unknown> = {
      'agent.transport': 'http',
      'agent.retryAttempts': 0,
      'agent.reasoningEffort': 'none',
      'agent.maxOutputTokens': 2_000,
    };
    settings = {
      get: (key: string) => values[key],
      getDynamic: (key: string) => (key === 'providers' ? [config] : undefined),
    } as unknown as ISettingsService;
    logger = { debug() {}, info() {}, warn() {}, error() {} } as unknown as ILoggingService;
    agent = {
      name: 'Live fixture',
      model: 'fixture-model',
      instructions: 'SYSTEM-PREFIX: keep original constraints and never duplicate completed writes.',
      modelSettings: { maxTokens: 2_000, providerData: { prompt_cache_key: 'stable-root-cache' } },
      tools: [
        {
          name: 'fixture_write',
          description: 'A tool whose executable body must never run during compaction.',
          parameters: z.object({ path: z.string() }),
          needsApproval: () => false,
          formatCommandMessage: () => [],
          execute: async () => {
            executions++;
            return 'wrote';
          },
        },
      ],
    };
    chat = new AgentChatService({
      agentConfig: {
        getProvider: () => provider,
        getModel: () => agent.model,
        getAgent: () => agent,
        reasoningEffort: 'none',
      } as unknown as AgentConfiguration,
      settings,
      logger,
    });
  });

  afterEach(async () => {
    await chat?.dispose();
    unregisterProvider(provider);
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  });

  function compact(inputHistory = history(), inputLimit?: number, signal?: AbortSignal) {
    const compactor = new LocalContextCompactor({
      requestContext: { instructions: agent.instructions, tools: toModelTools(agent.tools) },
      generate: async ({ history: liveHistory, renderedInput, maxOutputTokens, signal: requestSignal }) => {
        const result = liveHistory
          ? await chat.summarizeHistory(liveHistory, renderedInput, agent, provider, maxOutputTokens, requestSignal)
          : await chat.chatDetailed(renderedInput, {
              provider,
              model: agent.model,
              instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
              maxTokens: maxOutputTokens,
              signal: requestSignal,
            });
        return {
          text: result.text,
          costRecords: result.costRecords,
          usage: { inputTokens: result.usage?.prompt_tokens, outputTokens: result.usage?.completion_tokens },
        };
      },
    });
    return compactor.compactAtBoundary({
      history: inputHistory,
      provider,
      model: agent.model,
      sourceRevision: 42,
      contextWindow: 100_000,
      maxOutputTokens: 2_000,
      maxRequestInputTokens: inputLimit,
      compactThreshold: 0.8,
      compactThresholdTokens: null,
      manual: true,
      signal,
    });
  }

  function createClient(context = new SessionContextService(), transient = false) {
    const rootSettings = new SettingsService({
      disableLogging: true,
      disableFilePersistence: true,
      cli: {
        providers: settings.getDynamic('providers') as never,
        agent: {
          modelSelection: { provider, model: agent.model },
          contextCompaction: { enabled: true, mode: 'local', compactThresholdTokens: 1_000 },
          maxRequestInputTokens: 30_000,
          sessionRollover: { enabled: false },
          runBudget: { escalation: 'disabled' },
        } as never,
      },
    });
    return new AgentClient({
      selection: { provider, model: agent.model },
      ...(transient ? { agentOverride: agent } : {}),
      toolOwnership: new ToolOwnershipRegistry(),
      deps: {
        settings: rootSettings,
        logger: new LoggingService({ disableLogging: true }),
        sessionContextService: context,
      },
    });
  }

  it('appends one summary request without changing live system, tools, cache key, or history', async () => {
    const inputHistory = history();
    const original = structuredClone(inputHistory);
    const model = await getProvider(provider)!.createStreamedModel!(agent.model, {
      settingsService: settings,
      loggingService: logger,
    });
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const normal = loop.startStream(agent, inputHistory, { providerId: provider, maxTurns: 1 });
    await normal.completed;
    const outcome = await compact(inputHistory);
    expect(outcome.kind).toBe('compacted');
    expect(requests).toHaveLength(2);
    const [live, summaryRequest] = requests;
    expect(summaryRequest!.messages.slice(0, -1)).toEqual(live!.messages);
    expect(summaryRequest!.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: CONTEXT_COMPACTION_REQUEST }],
    });
    expect(summaryRequest!.tools).toEqual(live!.tools);
    expect(summaryRequest!.prompt_cache_key).toBe('stable-root-cache');
    expect(summaryRequest!.messages.some((message: any) => message.content === 'old output '.repeat(6_000))).toBe(true);
    expect(inputHistory).toEqual(original);
    expect(executions).toBe(0);
    if (outcome.kind !== 'compacted') throw new Error('Expected checkpoint');
    expect(outcome.checkpoint.contextSummary.replacesThroughRevision).toBe(42);
    expect(outcome.hotTail).toContainEqual(original[5]);
    expect(outcome.usage).toEqual({ inputTokens: 16_000, outputTokens: 80 });
    expect(outcome.costRecords).toHaveLength(1);
    expect(outcome.costRecords[0]!.usage?.cache_read_tokens).toBe(15_000);
  });

  it('uses the new generator through the real AgentClient automatic boundary', async () => {
    const client = createClient(undefined, true);
    try {
      const stream = await client.startStream(history(), { sessionId: 'fixture-root' });
      await stream.completed;
      expect(requests).toHaveLength(2);
      expect(requests[0]!.messages.at(-1).content[0].text).toBe(CONTEXT_COMPACTION_REQUEST);
      expect(requests[0]!.messages[0].content).toBe(agent.instructions);
      expect(requests[0]!.prompt_cache_key).toBe('stable-root-cache');
      expect(JSON.stringify(requests[1]!.messages)).toContain('Compacted Conversation Context');
      expect(JSON.stringify(requests[1]!.messages)).not.toContain('old output '.repeat(100));
      expect(requests[1]!.tools).toEqual(requests[0]!.tools);
      expect(executions).toBe(0);
    } finally {
      await client.dispose();
    }
  });

  it('retains root cache affinity without reusing helper chains or sharing it with nested scopes', async () => {
    const observed: Array<SessionTrafficContext | null | undefined> = [];
    const released: Array<string | undefined> = [];
    const context = new SessionContextService();
    const client = createClient(context);
    const transient = createClient(context, true);
    const definition = getProvider(provider)!;
    upsertProvider({
      ...definition,
      createStreamedModel: async (model, deps) => {
        const underlying = await definition.createStreamedModel!(model, deps);
        return {
          resetConversationState(options) {
            released.push(options?.providerHistoryKey);
            underlying.resetConversationState?.(options);
          },
          async *stream(request) {
            observed.push(deps.sessionContextService?.getContext());
            yield* underlying.stream(request);
          },
        };
      },
    });
    const request = {
      history: history(),
      priorSummary: null,
      transcriptChunk: '',
      renderedInput: CONTEXT_COMPACTION_REQUEST,
      maxOutputTokens: 2_000,
    };
    try {
      const generator = client.createContextSummaryGenerator('root-logical', 'root-cache');
      await generator.generate(request);
      await generator.generate(request);
      await context.runWithContext(
        {
          sessionId: 'root-logical',
          sessionStartedAt: new Date().toISOString(),
          promptCacheKey: 'root-cache',
          providerHistoryKey: 'root-logical:subagent:child',
        },
        () => client.createContextSummaryGenerator().generate(request),
      );
      await transient.createContextSummaryGenerator('root-logical', 'root-cache').generate(request);
      await context.runWithContext(
        {
          sessionId: 'root-logical',
          sessionStartedAt: new Date().toISOString(),
          promptCacheKey: 'root-cache',
          evaluator: true,
        },
        () => client.createContextSummaryGenerator().generate(request),
      );
      responseMode = 'error';
      await expect(generator.generate(request)).rejects.toThrow();
      expect(observed).toHaveLength(6);
      expect(observed[0]).toMatchObject({ rootContextCompaction: true, promptCacheKey: 'root-cache' });
      expect(observed[1]).toMatchObject({ rootContextCompaction: true, promptCacheKey: 'root-cache' });
      expect(observed[0]!.providerHistoryKey).not.toBe(observed[1]!.providerHistoryKey);
      expect(observed[2]!.providerHistoryKey).toMatch(/^root-logical:subagent:child:context-summary:/);
      expect(observed[2]!.rootContextCompaction).toBeUndefined();
      expect(observed[3]!.rootContextCompaction).toBeUndefined();
      expect(observed[4]!.rootContextCompaction).toBeUndefined();
      expect(requests).toHaveLength(6);
      expect(released).toEqual(observed.map((traffic) => traffic!.providerHistoryKey));
      expect(released).not.toContain('root-logical');
      expect(executions).toBe(0);
    } finally {
      await client.dispose();
      await transient.dispose();
    }
  });

  it('keeps OpenCode sticky routing for root summaries but not nested requests', async () => {
    const context = new SessionContextService();
    const inject = createOpencodeSessionInjector(
      { name: 'opencode', type: 'opencode' },
      { sessionContextService: context },
    );
    if (!inject) throw new Error('Missing OpenCode header injector');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture socket');
    const baseContext: SessionTrafficContext = {
      sessionId: 'logical-after-rollover',
      sessionStartedAt: new Date().toISOString(),
      promptCacheKey: 'stable-root-affinity',
    };
    for (const trafficContext of [
      baseContext,
      { ...baseContext, providerHistoryKey: 'isolated-helper', rootContextCompaction: true as const },
      { ...baseContext, providerHistoryKey: 'nested-child' },
    ]) {
      await context.runWithContext(trafficContext, async () => {
        const response = await fetch(`http://127.0.0.1:${address.port}`, inject({ method: 'POST', body: '{}' })!);
        await response.text();
      });
    }
    expect(requestHeaders[0]!['x-opencode-session']).toBeTruthy();
    expect(requestHeaders[1]!['x-opencode-session']).toBe(requestHeaders[0]!['x-opencode-session']);
    expect(requestHeaders[2]!['x-opencode-session']).not.toBe(requestHeaders[0]!['x-opencode-session']);
  });

  it('falls back to bounded serialized generation when the live prefix exceeds admission', async () => {
    const outcome = await compact(history(), 8_000);
    expect(outcome.kind).toBe('compacted');
    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]!.messages[0].content).toBe(CONTEXT_COMPACTION_INSTRUCTIONS);
    expect(requests[0]!.messages.at(-1).content[0].text).toContain('Historical transcript chunk');
    expect(requests[0]!.messages.at(-1).content[0].text).toContain('truncated tool result');
    expect(executions).toBe(0);
  });

  it('never executes tools requested by the summarizer', async () => {
    responseMode = 'tool';
    const original = history();
    const before = structuredClone(original);
    await expect(compact(original)).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(executions).toBe(0);
    expect(original).toEqual(before);
  });

  it.each(['empty', 'error'] as const)('leaves source history untouched after a provider %s response', async (mode) => {
    responseMode = mode;
    const original = history();
    const before = structuredClone(original);
    await expect(compact(original)).rejects.toThrow();
    expect(original).toEqual(before);
    expect(executions).toBe(0);
  });

  it('does not dispatch after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(compact(history(), undefined, controller.signal)).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});
