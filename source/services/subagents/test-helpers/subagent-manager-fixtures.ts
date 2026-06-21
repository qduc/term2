import { afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentClient } from '../../../lib/agent-client.js';
import { registerProvider, unregisterProvider, type ProviderDefinition } from '../../../providers/registry.js';
import { ExecutionContext } from '../../execution-context.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../../service-interfaces.js';
import type { ISubagentClient, ISubagentClientFactory } from '../subagent-client-types.js';
import { SubagentManager as RealSubagentManager } from '../subagent-manager.js';

const ROLE_MENTOR = 'mentor';
const ROLE_EXPLORER = 'explorer';
const ROLE_WORKER = 'worker';
const ROLE_RESEARCHER = 'researcher';

const registeredProviderIds = new Set<string>();

beforeEach(() => {
  registeredProviderIds.clear();
});

afterEach(() => {
  for (const id of registeredProviderIds) {
    unregisterProvider(id);
  }
  registeredProviderIds.clear();
});

export type MockRunner = (agent: any, input: any, options: any) => any;

export function registerTestProvider(
  partial: Partial<Omit<ProviderDefinition, 'id'>> & {
    id?: string;
  },
): string {
  const id = partial.id ?? `test-provider-${randomUUID()}`;
  registerProvider({
    id,
    label: partial.label ?? id,
    fetchModels: partial.fetchModels ?? (async () => []),
    capabilities: partial.capabilities,
    createRunner: partial.createRunner,
  });
  registeredProviderIds.add(id);
  return id;
}

export function createMockLogger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
  };
}

export function createMockSettings(values: Record<string, unknown> = {}): ISettingsService {
  const store: Record<string, unknown> = { ...values };
  return {
    get: <T>(key: string) => store[key] as T,
    set: (key: string, value: unknown) => {
      store[key] = value;
    },
  };
}

export function createSessionContextService(): ISessionContextService {
  return {
    runWithContext: (_context, fn) => fn(),
    getContext: () => null,
  };
}

export function createMockExecutionContext(cwd = '/tmp/workspace'): ExecutionContext {
  return {
    getCwd: () => cwd,
    isRemote: () => false,
    getSSHService: () => undefined,
  };
}

export function getAgentTool(agent: any, name: string): any {
  return agent.tools.find((tool: any) => tool.name === name);
}

export function wrapResultAsAgentStream(result: any): any {
  const events: any[] = [];
  if (typeof result.finalOutput === 'string' && result.finalOutput) {
    events.push({ type: 'response.output_text.delta', delta: result.finalOutput });
  }

  const findSynthesizedOutput = (): unknown[] => {
    if (Array.isArray(result.output) && result.output.length > 0) return result.output;
    if (Array.isArray(result.newItems) && result.newItems.length > 0) return result.newItems;
    if (Array.isArray(result.history) && result.history.length > 0) return result.history;
    if (typeof result.finalOutput === 'string' && result.finalOutput) {
      return [{ role: 'assistant', type: 'message', content: result.finalOutput }];
    }
    return [];
  };

  const synthesizedOutput = findSynthesizedOutput();

  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) {
            return { value: events[index++], done: false };
          }
          return { value: undefined, done: true };
        },
      };
    },
    completed: Promise.resolve(result),
    rawResponses: [result],
    status: result.status ?? 'completed',
    finalOutput: result.finalOutput,
    state: result.state,
    output: synthesizedOutput,
    newItems: result.newItems ?? synthesizedOutput,
    interruptions: result.interruptions ?? [],
    history: result.history ?? synthesizedOutput,
    messages: result.messages ?? synthesizedOutput,
    responseId: result.responseId ?? null,
    lastResponseId: result.responseId ?? null,
  };
}

export function wrapErrorAsAgentStream(error: any): any {
  const completed = Promise.reject(error);
  completed.catch(() => {});
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw error;
        },
      };
    },
    completed,
    rawResponses: [],
    status: 'failed',
    interruptions: [],
    history: [],
    messages: [],
    responseId: null,
    lastResponseId: null,
  };
}

export function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export class TestSubagentManager extends RealSubagentManager {
  constructor(deps: {
    logger?: ILoggingService;
    settings: ISettingsService;
    executionContext?: ExecutionContext;
    sessionContextService?: ISessionContextService;
    onEvent?: (event: any) => void;
    agentClient?: ISubagentClient;
    createClient?: ISubagentClientFactory['createClient'];
  }) {
    const logger = deps.logger ?? createMockLogger();
    const sessionContextService = deps.sessionContextService ?? createSessionContextService();
    super({
      logger,
      settings: deps.settings,
      executionContext: deps.executionContext,
      sessionContextService,
      onEvent: deps.onEvent,
      agentClient: deps.agentClient,
      createClient:
        deps.createClient ??
        (({ agent, provider, maxTurns, retryAttempts }: any) =>
          new AgentClient({
            model: agent.model,
            maxTurns,
            retryAttempts,
            deps: {
              logger,
              settings: deps.settings,
              executionContext: deps.executionContext,
              sessionContextService,
            },
            agentOverride: agent,
            providerOverride: provider,
          })),
    });
  }
}

export { ROLE_MENTOR, ROLE_EXPLORER, ROLE_WORKER, ROLE_RESEARCHER };
