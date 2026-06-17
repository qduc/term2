import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { LoggingService } from '../logging/logging-service.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import type { LLMAdvisory } from '../../contracts/conversation.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

const logger = new LoggingService({ disableLogging: true });

const makeMockSettings = (mode: 'off' | 'advisory' | 'auto') => ({
  get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? (mode as unknown as T) : undefined),
});

const makeAdvisory = (overrides: Partial<LLMAdvisory> = {}): LLMAdvisory => ({
  approved: true,
  source: 'llm',
  reasoning: 'safe',
  model: 'test',
  ...overrides,
});

const makeMockAgentClient = (_advisories: Record<string, LLMAdvisory>): any => {
  return {
    chat: async () => '{"results":[]}',
  };
};

it('non-shell tools return undefined advisory', async () => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });

  const advisory = await resolver.resolveAdvisoryForInterruption({
    interruption: { name: 'find_files', arguments: { query: 'foo' } },
    siblings: [],
  });

  expect(advisory).toBe(undefined);
});

it('getAutoApproveMode reads setting', () => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('advisory') as any,
    sessionContextService: createSessionContextService() as any,
  });
  expect(resolver.getAutoApproveMode()).toBe('advisory');
});

it('shouldAutoApprove requires auto mode + approved + llm source', () => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });
  expect(resolver.shouldAutoApprove(makeAdvisory({ approved: true, source: 'llm' }))).toBe(true);
  expect(resolver.shouldAutoApprove(makeAdvisory({ approved: false, source: 'llm' }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ approved: true, source: 'system' }))).toBe(false);
  expect(resolver.shouldAutoApprove(undefined)).toBe(false);
});

it('shouldAutoApprove returns false when mode is not auto', () => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('advisory') as any,
    sessionContextService: createSessionContextService() as any,
  });
  expect(resolver.shouldAutoApprove(makeAdvisory({ approved: true, source: 'llm' }))).toBe(false);
});

it('clearCache empties cached advisories so next eval re-runs LLM', async () => {
  let chatCount = 0;
  const agentClient: any = {
    chat: async () => {
      chatCount++;
      return '{"results":[{"id":"c1","reasoning":"ok","approved":true}]}';
    },
  };
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient,
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });

  const interruption = { name: 'shell', arguments: { command: 'ls' }, callId: 'c1' };
  const a1 = await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  expect(a1).toBeTruthy();
  await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  expect(chatCount, 'second call uses cache').toBe(1);

  resolver.clearCache();
  await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  expect(chatCount, 'after clearCache, evaluation runs again').toBe(2);
});

it('interruption without callId uses inline __single__ evaluation', async () => {
  let chatCount = 0;
  let promptSeen = '';
  const agentClient: any = {
    chat: async (prompt: string) => {
      chatCount++;
      promptSeen = prompt;
      return '{"results":[{"id":"__single__","reasoning":"ok","approved":true}]}';
    },
  };
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient,
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });

  const interruption = { name: 'shell', arguments: { command: 'ls' } };
  const advisory = await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  expect(advisory).toBeTruthy();
  expect(advisory?.approved).toBe(true);
  expect(chatCount).toBe(1);
  expect(promptSeen.includes('ls')).toBe(true);
});
