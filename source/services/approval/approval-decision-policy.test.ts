import { it, expect } from 'vitest';
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
    llmAdvisory: {
      reasoning: 'safe',
      approved: true,
      model: 'test',
      source: 'llm',
      riskLevel: 'low',
      authorization: 'implied',
      confidence: 'high',
    },
  });
  expect(result).toBe('approve');
});

it('ShellAutoApprovalDecisionPolicy approves always-mode shell commands without an advisory', async () => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined =>
        key === 'shell.autoApproveMode' ? ('always' as unknown as T) : undefined,
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  await expect(
    policy.decide({
      toolName: 'bash',
      argumentsText: 'pnpm test --help',
      callId: 'c-always-no-advisory',
    }),
  ).resolves.toBe('approve');
});

it('ShellAutoApprovalDecisionPolicy approves every tool except ask_user in always mode', async () => {
  const client = createMockAgentClient();
  const conversationStore = new ConversationStore();

  const shellAutoApproval = new ShellAutoApprovalResolver({
    conversationStore,
    agentClient: client as any,
    logger,
    settingsService: {
      get: <T>(key: string): T | undefined =>
        key === 'shell.autoApproveMode' ? ('always' as unknown as T) : undefined,
    } as any,
    sessionContextService: {
      runWithContext: <T>(_context: any, fn: () => T) => fn(),
      getContext: () => null,
    },
  });

  const policy = new ShellAutoApprovalDecisionPolicy(shellAutoApproval);

  await expect(policy.decide({ toolName: 'apply_patch', argumentsText: 'patch', callId: 'patch-yolo' })).resolves.toBe(
    'approve',
  );
  await expect(policy.decide({ toolName: 'ask_user', argumentsText: 'question', callId: 'ask-yolo' })).resolves.toBe(
    'prompt',
  );
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

it('ShellAutoApprovalDecisionPolicy approves file read and mutation tools with valid LLM advisory', async () => {
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

  const lowRiskAdvisory = {
    reasoning: 'reads log file outside workspace',
    approved: true,
    model: 'test',
    source: 'llm' as const,
    riskLevel: 'low' as const,
    authorization: 'implied' as const,
    confidence: 'high' as const,
  };

  // Group 2: read_file
  await expect(
    policy.decide({
      toolName: 'read_file',
      argumentsText: '{"path":"/tmp/test.log"}',
      callId: 'c-read',
      llmAdvisory: lowRiskAdvisory,
    }),
  ).resolves.toBe('approve');

  // Group 2: grep
  await expect(
    policy.decide({
      toolName: 'grep',
      argumentsText: '{"path":"/tmp","pattern":"foo"}',
      callId: 'c-grep',
      llmAdvisory: lowRiskAdvisory,
    }),
  ).resolves.toBe('approve');

  // Group 3: create_file
  await expect(
    policy.decide({
      toolName: 'create_file',
      argumentsText: '{"path":"/tmp/output.txt","content":"hello"}',
      callId: 'c-create',
      llmAdvisory: {
        ...lowRiskAdvisory,
        reasoning: 'creates temp output file',
        riskLevel: 'medium',
      },
    }),
  ).resolves.toBe('approve');

  // Group 3: apply_patch
  await expect(
    policy.decide({
      toolName: 'apply_patch',
      argumentsText: '{"path":"/tmp/config.json","diff":"..."}',
      callId: 'c-patch',
      llmAdvisory: {
        ...lowRiskAdvisory,
        reasoning: 'patches temp config',
        riskLevel: 'medium',
      },
    }),
  ).resolves.toBe('approve');
});

it('ShellAutoApprovalDecisionPolicy rejects ask_user and high-risk file operations', async () => {
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

  // ask_user is never auto-approved
  await expect(
    policy.decide({
      toolName: 'ask_user',
      argumentsText: 'question',
      callId: 'c-ask',
      llmAdvisory: {
        reasoning: 'harmless question',
        approved: true,
        model: 'test',
        source: 'llm',
        riskLevel: 'low',
        authorization: 'explicit',
        confidence: 'high',
      },
    }),
  ).resolves.toBe('prompt');

  // high risk read_file is prompted
  await expect(
    policy.decide({
      toolName: 'read_file',
      argumentsText: '{"path":"~/.ssh/id_rsa"}',
      callId: 'c-read-ssh',
      llmAdvisory: {
        reasoning: 'sensitive credential',
        approved: false,
        model: 'test',
        source: 'llm',
        riskLevel: 'high',
        authorization: 'unknown',
        confidence: 'high',
      },
    }),
  ).resolves.toBe('prompt');
});
