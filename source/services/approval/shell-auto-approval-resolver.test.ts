import test from 'ava';
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

test('non-shell tools return undefined advisory', async (t) => {
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

  t.is(advisory, undefined);
});

test('getAutoApproveMode reads setting', (t) => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('advisory') as any,
    sessionContextService: createSessionContextService() as any,
  });
  t.is(resolver.getAutoApproveMode(), 'advisory');
});

test('shouldAutoApprove requires auto mode + approved + llm source', (t) => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });
  t.true(resolver.shouldAutoApprove(makeAdvisory({ approved: true, source: 'llm' })));
  t.false(resolver.shouldAutoApprove(makeAdvisory({ approved: false, source: 'llm' })));
  t.false(resolver.shouldAutoApprove(makeAdvisory({ approved: true, source: 'system' })));
  t.false(resolver.shouldAutoApprove(undefined));
});

test('shouldAutoApprove returns false when mode is not auto', (t) => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('advisory') as any,
    sessionContextService: createSessionContextService() as any,
  });
  t.false(resolver.shouldAutoApprove(makeAdvisory({ approved: true, source: 'llm' })));
});

test('clearCache empties cached advisories so next eval re-runs LLM', async (t) => {
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
  t.truthy(a1);
  await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  t.is(chatCount, 1, 'second call uses cache');

  resolver.clearCache();
  await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  t.is(chatCount, 2, 'after clearCache, evaluation runs again');
});

test('interruption without callId uses inline __single__ evaluation', async (t) => {
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
  t.truthy(advisory);
  t.is(advisory?.approved, true);
  t.is(chatCount, 1);
  t.true(promptSeen.includes('ls'));
});
