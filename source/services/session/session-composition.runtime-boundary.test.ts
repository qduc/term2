import { it, expect } from 'vitest';
import { createSessionRuntime } from './session-composition.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import { createMockStream } from '../test-helpers/mock-stream.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: (): string | undefined => undefined,
  clearCorrelationId: () => {},
};

const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T): T => fn(),
  getContext: () => null,
};

function partialClient(): ConversationAgentClient {
  return {
    chat: async () => '',
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    startStream: async () => createMockStream([]),
    continueRunStream: async () => createMockStream([]),
  } as ConversationAgentClient;
}

it('createSessionRuntime omits composition internals while retaining its closed operations', () => {
  const runtime = createSessionRuntime({
    sessionId: 'runtime-boundary',
    agentClient: partialClient(),
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: mockLogger, sessionContextService },
  });

  for (const field of [
    'generationGuard',
    'conversationStore',
    'turnWorkflow',
    'stateFacade',
    'runtimeController',
    'appState',
  ]) {
    expect(field in runtime).toBe(false);
  }
  expect(typeof runtime.compactContext).toBe('function');
  expect(typeof runtime.shutdown).toBe('function');
  runtime.dispose();
});
