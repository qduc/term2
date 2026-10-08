import { afterEach, expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider, unregisterProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';
import type { StreamedModelTurnRequest } from '../contracts/streamed-model-turn.js';

/** Composition: the root client's approval-gated shell tool prompts for every call, even when ids repeat. */

const providers = new Set<string>();
afterEach(() => {
  for (const provider of providers) unregisterProvider(provider);
  providers.clear();
});

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
  log: () => {},
} as unknown as ILoggingService;

const sessionContextService = { runWithContext: <T>(_c: unknown, fn: () => T) => fn(), getContext: () => null } as any;

it('the root client prompts again for a later shell call that reuses call_0', async () => {
  const provider = `approval-binding-${Date.now()}`;
  providers.add(provider);
  const requests: StreamedModelTurnRequest[] = [];
  // The chat-completions adapter assigns call_${index} when the provider omits ids.
  const shellCall = (marker: string) => ({
    type: 'tool_call' as const,
    id: 'call_0',
    name: 'shell',
    arguments: JSON.stringify({ command: `true ${marker}`, sandbox: 'unsandboxed' }),
  });
  registerProvider({
    id: provider,
    label: provider,
    createStreamedModel: () => ({
      async *stream(request: StreamedModelTurnRequest) {
        requests.push(request);
        const n = requests.length;
        yield {
          type: 'completion' as const,
          responseId: `r-${n}`,
          output:
            n === 1
              ? [shellCall('first')]
              : n === 2
              ? [shellCall('second')]
              : [{ type: 'message' as const, content: [{ type: 'text' as const, text: 'done' }] }],
        };
      },
    }),
    fetchModels: async () => [],
  });
  const values: Record<string, unknown> = {
    'agent.modelSelection': { model: 'test-model', provider },
    'agent.retryAttempts': 0,
    'agent.reasoningEffort': 'default',
  };
  const settings = {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => void (values[key] = value),
    getDynamic: (key: string) => values[key],
    setDynamic: (key: string, value: unknown) => void (values[key] = value),
    setPersistent: (key: string, value: unknown) => void (values[key] = value),
    setPersistentDynamic: (key: string, value: unknown) => void (values[key] = value),
  } as ISettingsService;
  const instance = new AgentClient({
    deps: { logger, settings, sessionContextService },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);
  try {
    const first = await instance.startStream('run two commands');
    await first.completed;
    expect(first.interruptions).toHaveLength(1);
    (first.state as any).approve?.(first.interruptions![0]);

    const second = await instance.continueRunStream(first.state!);
    await second.completed;

    // The second shell call is new: it must be presented before it can run.
    expect(requests).toHaveLength(2);
    expect(second.interruptions).toHaveLength(1);
    expect(JSON.stringify(second.interruptions![0])).toContain('true second');
  } finally {
    instance.dispose();
  }
});
