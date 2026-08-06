import { afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { AgentClient } from '../../../lib/agent-client.js';
import { ToolOwnershipRegistry } from '../../approval/tool-ownership-registry.js';
import { registerProvider, unregisterProvider, type ProviderDefinition } from '../../../providers/registry.js';
import { ExecutionContext } from '../../execution-context.js';
import type { ILoggingService, ISettingsService, ISessionContextService } from '../../service-interfaces.js';
import type { ISubagentClient, ISubagentClientFactory } from '../subagent-client-types.js';
import { SubagentManager as RealSubagentManager } from '../subagent-manager.js';

const ROLE_MENTOR = 'mentor';
const ROLE_EXPLORER = 'explorer';
const ROLE_WORKER = 'worker';

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

export type MockStreamedModelFactory = (model: string, deps: any) => any;

export function registerTestProvider(
  partial: Partial<Omit<ProviderDefinition, 'id'>> & {
    id?: string;
  },
): string {
  const id = partial.id ?? `test-provider-${randomUUID()}`;
  const createStreamedModel = partial.createStreamedModel;
  registerProvider({
    id,
    label: partial.label ?? id,
    fetchModels: partial.fetchModels ?? (async () => []),
    capabilities: partial.capabilities,
    createStreamedModel,
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

  const getNested = (key: string): unknown => {
    const keys = key.split('.');
    let value: unknown = store;
    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = (value as Record<string, unknown>)[k];
      } else {
        return undefined;
      }
    }
    return value;
  };

  // Mirrors SettingsService.getDynamic (dotted-key traversal) while keeping the
  // flat-store fallback so callers that configure flat dotted keys keep working.
  const get = (key: string): unknown => {
    const nested = getNested(key);
    return nested === undefined ? store[key] : nested;
  };

  // Mirrors SettingsService set-family behavior: dotted keys create nested
  // objects as needed instead of writing a flat key.
  const setNested = (key: string, value: unknown): void => {
    const keys = key.split('.');
    let obj: Record<string, unknown> = store;
    for (let i = 0; i < keys.length - 1; i++) {
      const next = obj[keys[i]];
      if (next && typeof next === 'object') {
        obj = next as Record<string, unknown>;
      } else {
        const created: Record<string, unknown> = {};
        obj[keys[i]] = created;
        obj = created;
      }
    }
    obj[keys[keys.length - 1]] = value;
  };

  return {
    get: (key: any) => get(key as string) as any,
    getDynamic: (key: string) => get(key),
    set: (key: any, value: unknown) => {
      setNested(key as string, value);
    },
    setDynamic: (key: string, value: unknown) => {
      setNested(key, value);
    },
    setPersistent: (key: any, value: unknown) => {
      setNested(key as string, value);
    },
    setPersistentDynamic: (key: string, value: unknown) => {
      setNested(key, value);
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

export async function* wrapResultAsAgentStream(result: any): AsyncGenerator<any> {
  if (typeof result.finalOutput === 'string' && result.finalOutput) {
    yield { type: 'text_delta', text: result.finalOutput };
  }
  yield {
    type: 'completion',
    responseId: result.responseId ?? 'fixture-response',
    output:
      typeof result.finalOutput === 'string' && result.finalOutput
        ? [{ type: 'message', content: [{ type: 'text', text: result.finalOutput }] }]
        : [],
  };
}

export async function* wrapErrorAsAgentStream(error: any): AsyncGenerator<any> {
  throw error;
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
    skillsService?: any;
  }) {
    const logger = deps.logger ?? createMockLogger();
    const sessionContextService = deps.sessionContextService ?? createSessionContextService();
    const toolOwnership = new ToolOwnershipRegistry();
    super({
      logger,
      settings: deps.settings,
      executionContext: deps.executionContext,
      sessionContextService,
      onEvent: deps.onEvent,
      agentClient: deps.agentClient,
      skillsService: deps.skillsService,
      toolOwnership,
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
              skillsService: deps.skillsService,
            },
            agentOverride: agent,
            providerOverride: provider,
            toolOwnership,
          })),
    });
  }
}

export { ROLE_MENTOR, ROLE_EXPLORER, ROLE_WORKER };
