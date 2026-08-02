import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { registerProvider } from '../providers/registry.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import type { ILoggingService, ISettingsService } from '../services/service-interfaces.js';

const providers = new Set<string>();
const makeSettings = (provider: string): ISettingsService => {
  const values: Record<string, unknown> = {
    'agent.provider': provider,
    'agent.model': 'test-model',
    'agent.retryAttempts': 2,
    'agent.reasoningEffort': 'default',
  };
  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => void (values[key] = value),
    getDynamic: (key: string) => values[key],
    setDynamic: (key: string, value: unknown) => void (values[key] = value),
    setPersistent: (key: string, value: unknown) => void (values[key] = value),
    setPersistentDynamic: (key: string, value: unknown) => void (values[key] = value),
  } as ISettingsService;
};
const logger: ILoggingService = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
  log: () => {},
} as ILoggingService;
const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
  getContext: () => null,
} as any;

const client = (provider: string, options: Record<string, unknown> = {}) =>
  new AgentClient({
    ...options,
    deps: { logger, settings: makeSettings(provider), sessionContextService },
    toolOwnership: new ToolOwnershipRegistry(),
  } as any);

afterEach(() => {
  for (const provider of providers) {
    // Providers are intentionally process-global; unique IDs keep this file
    // isolated without mutating the registry during a test.
    void provider;
  }
});

describe('AgentClient application-run-loop execution', () => {
  it('executes an override agent with its original tool definitions', async () => {
    const provider = `override-direct-${Date.now()}`;
    providers.add(provider);
    let executed = 0;
    let turn = 0;
    registerProvider({
      id: provider,
      label: 'Override direct test provider',
      createStreamedModel: () => ({
        async *stream() {
          turn += 1;
          if (turn === 1) {
            yield {
              type: 'completion',
              responseId: 'one',
              output: [{ type: 'tool_call', id: 'call-1', name: 'identity', arguments: '{}' }],
            };
          } else {
            yield {
              type: 'completion',
              responseId: 'two',
              output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
            };
          }
        },
      }),
      fetchModels: async () => [],
    });
    const tool = {
      name: 'identity',
      description: 'identity',
      parameters: {},
      needsApproval: async () => false,
      execute: async () => {
        executed += 1;
        return 'ok';
      },
    } as any;
    const overrideAgent = { name: 'override', model: 'test-model', instructions: 'test', tools: [tool] } as any;
    const instance = client(provider, {
      agentOverride: overrideAgent,
      maxTurns: 2,
    });
    const stream = await instance.startStream('run');
    await stream.completed;
    expect(executed).toBe(1);
    instance.dispose();

    turn = 0;
    const defaultInstance = client(provider, { agentOverride: overrideAgent });
    const defaultStream = await defaultInstance.startStream('run');
    await expect(defaultStream.completed).rejects.toThrow('Max turns (1) exceeded');
    defaultInstance.dispose();
  });

  it('fails clearly when a provider has no streamed-model factory', async () => {
    const provider = `runner-only-${Date.now()}`;
    providers.add(provider);
    registerProvider({
      id: provider,
      label: 'Missing streamed model test provider',
      fetchModels: async () => [],
    });
    const instance = client(provider);
    const stream = await instance.startStream('run');
    await expect(stream.completed).rejects.toThrow('does not expose an application streamed model');
    instance.dispose();
  });

  it('passes retry callback and aborts an active direct stream', async () => {
    const provider = `retry-cancel-${Date.now()}`;
    providers.add(provider);
    let retry: (() => void) | undefined;
    let resolve: (() => void) | undefined;
    registerProvider({
      id: provider,
      label: 'Retry cancellation test provider',
      createStreamedModel: (_model, deps) => {
        retry = deps.onRetry;
        return {
          async *stream(request: any) {
            retry?.();
            await new Promise<void>((done) => {
              resolve = done;
              request.signal?.addEventListener('abort', done, { once: true });
            });
            if (request.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            yield { type: 'completion', responseId: 'done', output: [] };
          },
        };
      },
      fetchModels: async () => [],
    });
    const instance = client(provider);
    let retries = 0;
    instance.setRetryCallback(() => {
      retries += 1;
    });
    const stream = await instance.startStream('run');
    expect(retry).toBeTypeOf('function');
    expect(retries).toBe(1);
    instance.abort();
    resolve?.();
    await expect(stream.completed).rejects.toMatchObject({ name: 'AbortError' });
    instance.dispose();
  });
});
