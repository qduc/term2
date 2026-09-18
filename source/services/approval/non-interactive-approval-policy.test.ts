import { expect, it, vi } from 'vitest';
import type { ApprovalDescriptor } from '../../contracts/conversation.js';
import {
  NonInteractiveApprovalPolicy,
  type NonInteractiveApprovalPolicyDeps,
} from './non-interactive-approval-policy.js';

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
    decisionShadow?: NonInteractiveApprovalPolicyDeps['decisionShadow'];
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
    decisionShadow: input.decisionShadow,
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
    settings: { 'agent.choreModel': 'reviewer' },
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
    settings: { 'agent.choreModel': 'reviewer' },
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

it('waits for the optional shadow comparison before a non-interactive approval settles', async () => {
  let finishShadow!: (
    value: Array<{ riskLevel: 'low'; authorization: 'explicit'; confidence: number; wouldApprove: true }>,
  ) => void;
  const decisionShadow = vi.fn(
    () =>
      new Promise<Awaited<ReturnType<NonNullable<NonInteractiveApprovalPolicyDeps['decisionShadow']>>>>((resolve) => {
        finishShadow = resolve;
      }),
  );
  const policy = createPolicy({
    settings: {
      'shell.autoApproveMode': 'auto',
      'agent.choreModel': 'reviewer',
      'agent.autoApproveDecisionShadowModel': '~typesafe/jev-latest',
      'agent.openrouter.apiKey': 'test-key',
    },
    chat: async () =>
      JSON.stringify({
        results: [{ reasoning: 'Task aligned.', riskLevel: 'low', authorization: 'explicit', confidence: 'high' }],
      }),
    decisionShadow,
  });
  let settled = false;
  const pending = policy
    .decide({ autoApprove: true, approval: createApproval('bash', 'npm install') })
    .then((decision) => {
      settled = true;
      return decision;
    });
  await vi.waitFor(() => expect(decisionShadow).toHaveBeenCalledTimes(1));
  expect(settled).toBe(false);
  finishShadow([{ riskLevel: 'low', authorization: 'explicit', confidence: 1, wouldApprove: true }]);
  expect(await pending).toEqual({ answer: 'y' });
});

it('fails closed with the evaluator error reason for YELLOW shell commands', async () => {
  const decision = await createPolicy({
    settings: { 'agent.choreModel': 'reviewer' },
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
