import { expect, it } from 'vitest';
import { AgentClient } from './agent-client.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';

const settings = {
  get(key: string): unknown {
    return {
      'agent.provider': 'openai',
      'agent.model': 'gpt-5.6-luna',
      'agent.transport': 'http',
      'agent.retryAttempts': 0,
    }[key];
  },
} as any;

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  setCorrelationId() {},
  clearCorrelationId() {},
  getCorrelationId() {
    return undefined;
  },
  log() {},
} as any;

it('application-owned HTTP Responses providers retain their chaining capability', () => {
  const client = new AgentClient({
    deps: {
      logger,
      settings,
      sessionContextService: {
        runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
        getContext: () => null,
      } as any,
    },
    toolOwnership: new ToolOwnershipRegistry(),
  });

  expect(client.supportsConversationChaining()).toBe(true);
});
