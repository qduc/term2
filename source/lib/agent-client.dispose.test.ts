import { expect, it, vi } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { SubagentBridge } from './subagent-bridge.js';

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
