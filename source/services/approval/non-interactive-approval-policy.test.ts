import { expect, it } from 'vitest';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import { NonInteractiveApprovalPolicy } from './non-interactive-approval-policy.js';

const createLogger = () => ({
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {
    return undefined;
  },
  clearCorrelationId() {},
});

const createSessionContextService = () => ({
  getContext() {
    return null;
  },
  runWithContext<T>(_context: unknown, fn: () => T): T {
    return fn();
  },
});

const createApproval = (toolName: string, argumentsText: string, callId = 'call-1'): ApprovalDescriptor => ({
  agentName: 'CLI Agent',
  toolName,
  argumentsText,
  callId,
  rawInterruption: {},
});

const createPolicy = (
  input: {
    settings?: Record<string, unknown>;
    chat?: () => Promise<string>;
  } = {},
) =>
  new NonInteractiveApprovalPolicy({
    settingsService: input.settings
      ? ({
          get(key: string) {
            return input.settings?.[key];
          },
          getDynamic(key: string) {
            return input.settings?.[key];
          },
        } as any)
      : undefined,
    agentClient: input.chat
      ? ({
          chat: input.chat,
        } as any)
      : undefined,
    logger: createLogger(),
    sessionContextService: createSessionContextService(),
  });

it('rejects every tool when non-interactive auto-approval is disabled', async () => {
  const decision = await createPolicy().decide({
    autoApprove: false,
    approval: createApproval('apply_patch', '{"patch":"..."}'),
  });

  expect(decision).toEqual({
    answer: 'n',
    rejectionReason: 'Non-interactive mode: use --auto-approve to allow tool execution',
    reportRejection: false,
  });
});

it('approves non-shell tools when non-interactive auto-approval is enabled', async () => {
  const decision = await createPolicy().decide({
    autoApprove: true,
    approval: createApproval('apply_patch', '{"patch":"..."}'),
  });

  expect(decision).toEqual({ answer: 'y' });
});

it('fails closed for RED shell commands without consulting the evaluator', async () => {
  let chats = 0;
  const decision = await createPolicy({
    settings: { 'agent.autoApproveModel': 'reviewer' },
    chat: async () => {
      chats += 1;
      return '{"results":[{"approved":true,"reasoning":"safe"}]}';
    },
  }).decide({
    autoApprove: true,
    approval: createApproval('bash', 'rm -rf /'),
  });

  expect(decision).toEqual({
    answer: 'n',
    rejectionReason:
      'Heuristic validation failed: command is RED (dangerous) and cannot be executed automatically: rm -rf /',
    reportRejection: true,
  });
  expect(chats).toBe(0);
});

it('rejects YELLOW shell commands without a configured auto-approve model', async () => {
  const decision = await createPolicy().decide({
    autoApprove: true,
    approval: createApproval('bash', 'npm install'),
  });

  expect(decision).toEqual({
    answer: 'n',
    rejectionReason:
      'Heuristic validation failed: command is YELLOW (suspicious) and no auto-approve model is configured: npm install',
    reportRejection: true,
  });
});

it('uses the evaluator decision for YELLOW shell commands', async () => {
  const decision = await createPolicy({
    settings: { 'agent.autoApproveModel': 'reviewer' },
    chat: async () => '{"results":[{"approved":false,"reasoning":"requires confirmation"}]}',
  }).decide({
    autoApprove: true,
    approval: createApproval('bash', 'npm install'),
    getHistory: () => [],
  });

  expect(decision).toEqual({
    answer: 'n',
    rejectionReason: 'LLM evaluation rejected the command: requires confirmation',
    reportRejection: true,
  });
});

it('fails closed with the evaluator error reason for YELLOW shell commands', async () => {
  const decision = await createPolicy({
    settings: { 'agent.autoApproveModel': 'reviewer' },
    chat: async () => {
      throw new Error('reviewer unavailable');
    },
  }).decide({
    autoApprove: true,
    approval: createApproval('bash', 'npm install'),
    getHistory: () => [],
  });

  expect(decision).toEqual({
    answer: 'n',
    rejectionReason: 'LLM evaluation rejected the command: LLM evaluation encountered an error.',
    reportRejection: true,
  });
});
