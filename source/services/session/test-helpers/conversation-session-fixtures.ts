import { MockStream } from '../../test-helpers/mock-stream.js';
import type { ILoggingService, ISessionContextService, ISettingsService } from '../../service-interfaces.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';

export const mockLogger: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

export const sessionContextService: ISessionContextService = {
  runWithContext: (_context, fn) => fn(),
  getContext: () => null,
};

export type ClientCall = { input: unknown; opts?: unknown; provider?: string };

export const createMockSettingsService = (entries: [string, unknown][] = []): ISettingsService => {
  const settings = new Map(entries);
  return { get: <T>(key: string): T => settings.get(key) as T, set: () => {} };
};

export const createMockAgentClient = (overrides: Record<string, unknown> = {}): ConversationAgentClient =>
  ({
    startStream: async () => new MockStream([]),
    continueRunStream: async () => new MockStream([]),
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    chat: async () => '',
    ...overrides,
  } as unknown as ConversationAgentClient);
