import { it, expect } from 'vitest';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { LoggingService } from '../logging/logging-service.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import type { LLMAdvisory } from '../../contracts/conversation.js';

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

const logger = new LoggingService({ disableLogging: true });

const makeMockSettings = (mode: 'off' | 'advisory' | 'auto' | 'always') => ({
  get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? (mode as unknown as T) : undefined),
  getDynamic: (key: string) => (key === 'shell.autoApproveMode' ? mode : undefined),
});

const makeSandboxAwareSettings = (mode: 'off' | 'advisory' | 'auto' | 'always', sandboxEnabled: boolean) => ({
  get: <T>(key: string): T | undefined => {
    if (key === 'shell.autoApproveMode') return mode as unknown as T;
    if (key === 'sandbox.enabled') return sandboxEnabled as unknown as T;
    return undefined;
  },
  getDynamic: (key: string) => {
    if (key === 'shell.autoApproveMode') return mode;
    if (key === 'sandbox.enabled') return sandboxEnabled;
    return undefined;
  },
});

const makeResolver = (settings: any) =>
  new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: settings,
    sessionContextService: createSessionContextService() as any,
  });

const makeAdvisory = (overrides: Partial<LLMAdvisory> = {}): LLMAdvisory => ({
  approved: true,
  source: 'llm',
  reasoning: 'safe',
  model: 'test',
  riskLevel: 'low',
  authorization: 'implied',
  confidence: 'high',
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
    interruption: { name: 'glob', arguments: { query: 'foo' } },
    siblings: [],
  });

  expect(advisory).toBe(undefined);
});

it('forwards recorded manual decisions into the auto-approval evaluation', async () => {
  const prompts: string[] = [];
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: {
      chat: async (prompt: string) => {
        prompts.push(prompt);
        return JSON.stringify({ results: [{ reasoning: 'ok', approved: true }] });
      },
    } as any,
    logger,
    settingsService: makeMockSettings('advisory') as any,
    sessionContextService: createSessionContextService() as any,
  });

  resolver.recordManualDecision('rm -rf ./dist', 'approved');

  await resolver.resolveAdvisoryForInterruption({
    interruption: { name: 'shell', callId: 'call-1', arguments: JSON.stringify({ command: 'rm -rf ./build' }) },
    siblings: [{ name: 'shell', callId: 'call-1', arguments: JSON.stringify({ command: 'rm -rf ./build' }) }],
  });

  expect(prompts.length).toBe(1);
  expect(prompts[0]).toContain('[approved] rm -rf ./dist');
});

it('getAutoApproveMode reads setting', () => {
  const resolver = makeResolver(makeMockSettings('advisory') as any);
  expect(resolver.getAutoApproveMode()).toBe('advisory');
});

it('isUnsandboxedApprovalEligible requires sandbox enabled and mode != off', () => {
  expect(makeResolver(makeSandboxAwareSettings('off', true) as any).isUnsandboxedApprovalEligible()).toBe(false);
  expect(makeResolver(makeSandboxAwareSettings('advisory', true) as any).isUnsandboxedApprovalEligible()).toBe(true);
  expect(makeResolver(makeSandboxAwareSettings('auto', true) as any).isUnsandboxedApprovalEligible()).toBe(true);
});

it('isUnsandboxedApprovalEligible is always true in always mode regardless of sandbox', () => {
  expect(makeResolver(makeSandboxAwareSettings('always', true) as any).isUnsandboxedApprovalEligible()).toBe(true);
  expect(makeResolver(makeSandboxAwareSettings('always', false) as any).isUnsandboxedApprovalEligible()).toBe(true);
});

it('isUnsandboxedApprovalEligible is false when sandbox is disabled regardless of mode', () => {
  expect(makeResolver(makeSandboxAwareSettings('off', false) as any).isUnsandboxedApprovalEligible()).toBe(false);
  expect(makeResolver(makeSandboxAwareSettings('advisory', false) as any).isUnsandboxedApprovalEligible()).toBe(false);
  expect(makeResolver(makeSandboxAwareSettings('auto', false) as any).isUnsandboxedApprovalEligible()).toBe(false);
});

it('isUnsandboxedApprovalEligible treats missing sandbox.enabled as enabled', () => {
  expect(makeResolver(makeMockSettings('auto') as any).isUnsandboxedApprovalEligible()).toBe(true);
});

it('shouldAutoApprove fails closed on risk, authorization, confidence, and source', () => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });

  expect(resolver.shouldAutoApprove(makeAdvisory())).toBe(true);
  expect(resolver.shouldAutoApprove(makeAdvisory({ riskLevel: 'high' }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ authorization: 'weak' }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ authorization: 'unknown' }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ confidence: 'low' }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ approved: false }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ source: 'system' }))).toBe(false);
  expect(resolver.shouldAutoApprove(makeAdvisory({ riskLevel: undefined }))).toBe(false);
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

it('shouldAutoApprove returns true for any advisory (or none) in always mode', () => {
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient: makeMockAgentClient({}),
    logger,
    settingsService: makeMockSettings('always') as any,
    sessionContextService: createSessionContextService() as any,
  });
  // Even an undefined advisory auto-approves in YOLO mode.
  expect(resolver.shouldAutoApprove(undefined)).toBe(true);
  expect(resolver.shouldAutoApprove(makeAdvisory({ source: 'system', approved: false }))).toBe(true);
  expect(resolver.shouldAutoApprove(makeAdvisory({ riskLevel: 'high' }))).toBe(true);
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

it('flags unsandboxed siblings individually in the evaluation prompt', async () => {
  const prompts: string[] = [];
  const agentClient: any = {
    chat: async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({
        results: [
          { id: 'c-sandboxed', reasoning: 'safe', approved: true },
          { id: 'c-unsandboxed', reasoning: 'safe', approved: true },
        ],
      });
    },
  };
  const resolver = new ShellAutoApprovalResolver({
    conversationStore: new ConversationStore(),
    agentClient,
    logger,
    settingsService: makeMockSettings('auto') as any,
    sessionContextService: createSessionContextService() as any,
  });

  const sandboxed = { name: 'shell', callId: 'c-sandboxed', arguments: { command: 'ls' } };
  const unsandboxed = {
    name: 'shell',
    callId: 'c-unsandboxed',
    arguments: { command: 'curl https://example.com', sandbox: 'unsandboxed' },
  };

  await resolver.resolveAdvisoryForInterruption({ interruption: unsandboxed, siblings: [sandboxed, unsandboxed] });

  expect(prompts.length).toBe(1);
  const prompt = prompts[0];
  const sandboxedSection = prompt.slice(prompt.indexOf('ls'), prompt.indexOf('curl'));
  expect(sandboxedSection).not.toMatch(/OUTSIDE the sandbox/);
  expect(prompt.slice(prompt.indexOf('curl'))).toMatch(/OUTSIDE the sandbox/);
});

it('flags an unsandboxed no-callId interruption in the inline evaluation prompt', async () => {
  let promptSeen = '';
  const agentClient: any = {
    chat: async (prompt: string) => {
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

  const interruption = { name: 'shell', arguments: { command: 'curl https://example.com', sandbox: 'unsandboxed' } };
  const advisory = await resolver.resolveAdvisoryForInterruption({ interruption, siblings: [interruption] });
  expect(advisory?.approved).toBe(true);
  expect(promptSeen).toMatch(/OUTSIDE the sandbox/);
});
