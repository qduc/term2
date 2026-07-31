import { expect, it, vi } from 'vitest';
import { AgentClient as ProductionAgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { SubagentBridge } from './subagent-bridge.js';
import type { AgentRunOrchestratorDeps } from './agent-run-orchestrator.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { OpenAIResponsesModel, OpenAIResponsesWSModel } from '@openai/agents-openai';

class AgentClient extends ProductionAgentClient {
  constructor(options: Omit<ConstructorParameters<typeof ProductionAgentClient>[0], 'toolOwnership'>) {
    super({ ...options, toolOwnership: new ToolOwnershipRegistry() });
  }
}

const providerId = 'mock-provider-agent-client-dispose';

const createLogger = (): ILoggingService =>
  ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
    log: () => {},
  } as ILoggingService);

const createSettings = (): ISettingsService & { listeners: Array<(key?: string) => void> } => {
  const listeners: Array<(key?: string) => void> = [];
  return {
    listeners,
    get: <T>(key: string) => ({ 'agent.provider': providerId, 'agent.model': 'mock-model' }[key] as T),
    set: () => {},
    onChange: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
};

it.sequential('dispose ends session-bound bridge work without changing ordinary abort behavior', () => {
  registerProvider(
    {
      id: providerId,
      label: 'Agent client disposal provider',
      createRunner: () => ({ run: async () => ({ status: 'completed', finalOutput: '', messages: [] }) } as any),
      fetchModels: async () => [{ id: 'mock-model' }],
    },
    { allowOverride: true },
  );
  const settings = createSettings();
  const bridge = {
    abort: vi.fn(),
    dispose: vi.fn(),
    setEventSink: vi.fn(),
    setBackgroundEventSink: vi.fn(),
  } as unknown as SubagentBridge;
  const client = new AgentClient({
    deps: {
      logger: createLogger(),
      settings,
      sessionContextService: { runWithContext: <T>(_context: unknown, fn: () => T) => fn(), getContext: () => null },
    },
    subagentBridge: bridge,
  });

  client.abort();
  expect(bridge.abort).toHaveBeenCalledTimes(1);
  expect(bridge.dispose).not.toHaveBeenCalled();

  client.dispose();
  client.dispose();

  expect(bridge.dispose).toHaveBeenCalledTimes(1);
  expect(settings.listeners).toHaveLength(0);
});

it.sequential('passes an explicit frozen continuation projection mode to its run orchestrator', () => {
  const settings = createSettings();
  let received: AgentRunOrchestratorDeps | undefined;
  new AgentClient({
    deps: {
      logger: createLogger(),
      settings,
      sessionContextService: { runWithContext: <T>(_context: unknown, fn: () => T) => fn(), getContext: () => null },
      createRunOrchestrator: (orchestratorDeps) => {
        received = orchestratorDeps;
        return { abort() {} } as any;
      },
    },
    subagentBridge: {
      setEventSink() {},
      setBackgroundEventSink() {},
    } as unknown as SubagentBridge,
    continuationProjectionMode: 'openai-provider',
  });

  expect(received?.continuationProjectionMode).toBe('openai-provider');
});

it.sequential(
  'delivers a root request lifecycle observation through AgentClient and RunnerManager to both OpenAI transports',
  async () => {
    const originalHttpGetResponse = (OpenAIResponsesModel.prototype as any).getResponse;
    const originalWsGetResponse = (OpenAIResponsesWSModel.prototype as any).getResponse;
    const captures: any[] = [];
    let orchestratorDeps: AgentRunOrchestratorDeps | undefined;
    const settings = {
      get: <T>(key: string) =>
        ({
          'agent.provider': 'openai',
          'agent.model': 'gpt-test',
          'agent.retryAttempts': 0,
        }[key] as T),
      set() {},
      onChange: () => () => {},
    } as ISettingsService;
    const capture = { record() {}, observe: (entry: unknown) => captures.push(entry) };
    const respond = async function (request: any) {
      return { responseId: request.responseId };
    };
    (OpenAIResponsesModel.prototype as any).getResponse = respond;
    (OpenAIResponsesWSModel.prototype as any).getResponse = respond;
    try {
      new AgentClient({
        deps: {
          logger: createLogger(),
          settings,
          requestCapture: capture,
          sessionContextService: {
            runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
            getContext: () => null,
          },
          createRunOrchestrator: (deps) => {
            orchestratorDeps = deps;
            return { abort() {} } as any;
          },
        },
        subagentBridge: { setEventSink() {}, setBackgroundEventSink() {} } as unknown as SubagentBridge,
      });
      for (const transport of ['http', 'websocket'] as const) {
        (settings.get as any) = (key: string) =>
          ({
            'agent.provider': 'openai',
            'agent.model': 'gpt-test',
            'agent.retryAttempts': 0,
            'agent.transport': transport,
          }[key]);
        const runner = orchestratorDeps!.runnerManager.getOrCreateRunner('openai')!;
        const retryingModel: any = await runner.config.modelProvider!.getModel('gpt-test');
        await retryingModel.wrappedModel.getResponse({
          input: [{ role: 'user', content: 'captured' }],
          responseId: `${transport}-response`,
        });
        orchestratorDeps!.runnerManager.invalidateRunner();
      }
      expect(captures.filter((entry) => entry.phase === 'request-built')).toEqual([
        expect.objectContaining({
          provider: 'openai',
          transport: 'http',
          requestData: { input: [{ role: 'user', content: 'captured' }] },
        }),
        expect.objectContaining({
          provider: 'openai',
          transport: 'websocket',
          requestData: { input: [{ role: 'user', content: 'captured' }] },
        }),
      ]);
      expect(captures.filter((entry) => entry.phase === 'terminal').map((entry) => entry.responseId)).toEqual([
        'http-response',
        'websocket-response',
      ]);
    } finally {
      (OpenAIResponsesModel.prototype as any).getResponse = originalHttpGetResponse;
      (OpenAIResponsesWSModel.prototype as any).getResponse = originalWsGetResponse;
    }
  },
);
