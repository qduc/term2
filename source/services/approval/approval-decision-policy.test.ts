import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  ManualApprovalDecisionPolicy,
  ShellAutoApprovalDecisionPolicy,
  ApprovalDecisionPolicy,
} from './approval-decision-policy.js';
import { ShellAutoApprovalResolver } from './shell-auto-approval-resolver.js';
import { ConversationStore } from '../conversation/conversation-store.js';
import { LoggingService } from '../logging/logging-service.js';

const logger = new LoggingService({ disableLogging: true });

const createMockAgentClient = () => {
  let continueRunStreamResults: unknown[] = [];
  let startStreamResults: unknown[] = [];
  const continueRunStreamCalls: unknown[] = [];

  const client = {
    async startStream(_input: unknown, _options: unknown) {
      const result = startStreamResults.shift();
      if (!result) throw new Error('No startStream result');
      return result;
    },
    async continueRunStream(_state: unknown, _options: unknown) {
      continueRunStreamCalls.push({});
      const result = continueRunStreamResults.shift();
      if (!result) throw new Error('No continueRunStream result');
      return result;
    },
    abort() {},
    getStreamMaxRetries() {
      return 3;
    },
    shouldRetryWithoutFlexServiceTier() {
      return false;
    },
    setContinueRunStreamResults(results: unknown[]) {
      continueRunStreamResults = results;
    },
    setStartStreamResults(results: unknown[]) {
      startStreamResults = results;
    },
    get continueRunStreamCallsSnapshot() {
      return [...continueRunStreamCalls];
    },
  };

  return client;
};

// ── ManualApprovalDecisionPolicy ────────────────────────────────

it('ManualApprovalDecisionPolicy always returns prompt', async () => {
  const policy: ApprovalDecisionPolicy = new ManualApprovalDecisionPolicy();
  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'ls',
    callId: 'c1',
  });
  expect(result).toBe('prompt');
});

// ── ShellAutoApprovalDecisionPolicy ──────────────────────────────

it('ShellAutoApprovalDecisionPolicy returns approve for auto-approvable shell command', async () => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('auto' as unknown as T) : undefined),
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'ls',
    callId: 'c1',
    llmAdvisory: { reasoning: 'safe', approved: true, model: 'test', source: 'llm' },
  });
  expect(result).toBe('approve');
});

it('ShellAutoApprovalDecisionPolicy returns prompt for non-shell tool', async () => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('off' as unknown as T) : undefined),
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  const result = await policy.decide({
    toolName: 'apply_patch',
    argumentsText: 'patch',
    callId: 'c1',
  });
  expect(result).toBe('prompt');
});

it('ShellAutoApprovalDecisionPolicy returns prompt without advisory', async () => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('off' as unknown as T) : undefined),
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'ls',
    callId: 'c1',
  });
  expect(result).toBe('prompt');
});

it('ShellAutoApprovalDecisionPolicy returns prompt when advisory says not approved', async () => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined => (key === 'shell.autoApproveMode' ? ('off' as unknown as T) : undefined),
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  const result = await policy.decide({
    toolName: 'shell',
    argumentsText: 'rm -rf /',
    callId: 'c1',
    llmAdvisory: { reasoning: 'dangerous', approved: false, model: 'test', source: 'llm' },
  });
  expect(result).toBe('prompt');
});
