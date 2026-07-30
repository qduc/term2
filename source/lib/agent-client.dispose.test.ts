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
  'delivers a root request capture through AgentClient and RunnerManager to both OpenAI model builders',
  async () => {
    const originalHttpBuilder = (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest;
    const originalWsBuilder = (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest;
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
    const capture = { record: (entry: unknown) => captures.push(entry) };
    const builder = function () {
      return { requestData: { input: [{ role: 'user', content: 'captured' }] } };
    };
    (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = builder;
    (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = builder;
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
        retryingModel.wrappedModel._buildResponsesCreateRequest({}, true);
        orchestratorDeps!.runnerManager.invalidateRunner();
      }
      expect(captures).toEqual([
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
    } finally {
      (OpenAIResponsesModel.prototype as any)._buildResponsesCreateRequest = originalHttpBuilder;
      (OpenAIResponsesWSModel.prototype as any)._buildResponsesCreateRequest = originalWsBuilder;
    }
  },
);
