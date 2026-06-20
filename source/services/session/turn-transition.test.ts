import { it, expect } from 'vitest';
import { decideTurnTransition } from './turn-transition.js';
import type { ConversationTerminal, FinalTerminal, ApprovalRequiredTerminal } from '../../contracts/conversation.js';
import type { RetryCounts } from '../retry/retry-contracts.js';

// ── Helpers ────────────────────────────────────────────────────

const terminalResponse: ConversationTerminal = {
  type: 'response',
  commandMessages: [],
  finalText: 'hello',
} satisfies FinalTerminal;

const terminalApproval: ConversationTerminal = {
  type: 'approval_required',
  approval: {
    agentName: 'test',
    toolName: 'shell',
    argumentsText: 'ls',
    rawInterruption: {},
  },
} satisfies ApprovalRequiredTerminal;

const defaultRetryCounts: RetryCounts = {
  transientRetryCount: 1,
  serviceTierFallbackCount: 0,
  modelRetryCount: 0,
  transportDowngradeCount: 0,
};

// ── Valid transitions: streaming ───────────────────────────────

it('streaming + response → idle + emit_terminal', () => {
  const result = decideTurnTransition('streaming', { kind: 'response', terminal: terminalResponse });
  expect(result.next).toBe('idle');
  expect(result.command.kind).toBe('emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    expect(result.command.terminal).toBe(terminalResponse);
  }
});

it('streaming + approval_required → awaiting_approval + emit_terminal', () => {
  const result = decideTurnTransition('streaming', { kind: 'approval_required', terminal: terminalApproval });
  expect(result.next).toBe('awaiting_approval');
  expect(result.command.kind).toBe('emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    expect(result.command.terminal).toBe(terminalApproval);
  }
});

it('streaming + stale → streaming + none', () => {
  const result = decideTurnTransition('streaming', { kind: 'stale' });
  expect(result.next).toBe('streaming');
  expect(result.command.kind).toBe('none');
});

it('streaming + failed → idle + none', () => {
  const result = decideTurnTransition('streaming', { kind: 'failed' });
  expect(result.next).toBe('idle');
  expect(result.command.kind).toBe('none');
});

// ── Valid transitions: continuing ──────────────────────────────

it('continuing + response → idle + emit_terminal', () => {
  const result = decideTurnTransition('continuing', { kind: 'response', terminal: terminalResponse });
  expect(result.next).toBe('idle');
  expect(result.command.kind).toBe('emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    expect(result.command.terminal).toBe(terminalResponse);
  }
});

it('continuing + approval_required → awaiting_approval + emit_terminal', () => {
  const result = decideTurnTransition('continuing', { kind: 'approval_required', terminal: terminalApproval });
  expect(result.next).toBe('awaiting_approval');
  expect(result.command.kind).toBe('emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    expect(result.command.terminal).toBe(terminalApproval);
  }
});

it('continuing + stale → continuing + none', () => {
  const result = decideTurnTransition('continuing', { kind: 'stale' });
  expect(result.next).toBe('continuing');
  expect(result.command.kind).toBe('none');
});

it('continuing + fresh_start_required → streaming + re_drive', () => {
  const result = decideTurnTransition('continuing', {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
  });
  expect(result.next).toBe('streaming');
  expect(result.command.kind).toBe('re_drive');
  if (result.command.kind === 're_drive') {
    expect(result.command.options.skipUserMessage).toBe(true);
    expect(result.command.options.retries).toBe(defaultRetryCounts);
    expect(result.command.options.delayMs).toBe(undefined);
    expect(result.command.options.useStandardServiceTier).toBe(undefined);
  }
});

it('continuing + fresh_start_required with delayMs and useStandardServiceTier', () => {
  const result = decideTurnTransition('continuing', {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
    delayMs: 500,
    useStandardServiceTier: true,
  });
  expect(result.next).toBe('streaming');
  expect(result.command.kind).toBe('re_drive');
  if (result.command.kind === 're_drive') {
    expect(result.command.options.skipUserMessage).toBe(true);
    expect(result.command.options.delayMs).toBe(500);
    expect(result.command.options.useStandardServiceTier).toBe(true);
  }
});

// ── Invalid transitions ───────────────────────────────────────

it('idle + any outcome throws', () => {
  expect(() => decideTurnTransition('idle', { kind: 'stale' })).toThrow(/Invalid transition from idle/);

  expect(() => decideTurnTransition('idle', { kind: 'failed' })).toThrow(/Invalid transition from idle/);

  expect(() => decideTurnTransition('idle', { kind: 'response', terminal: terminalResponse })).toThrow(
    /Invalid transition from idle/,
  );
});

it('awaiting_approval + any outcome throws', () => {
  expect(() => decideTurnTransition('awaiting_approval', { kind: 'stale' })).toThrow(
    /Invalid transition from awaiting_approval/,
  );

  expect(() => decideTurnTransition('awaiting_approval', { kind: 'failed' })).toThrow(
    /Invalid transition from awaiting_approval/,
  );

  expect(() => decideTurnTransition('awaiting_approval', { kind: 'response', terminal: terminalResponse })).toThrow(
    /Invalid transition from awaiting_approval/,
  );
});

// ── Invalid outcome for state ──────────────────────────────────

it('streaming + fresh_start_required throws', () => {
  expect(() =>
    decideTurnTransition('streaming', {
      kind: 'fresh_start_required',
      retryCounts: defaultRetryCounts,
    }),
  ).toThrow();
});

it('continuing + failed throws', () => {
  expect(() => decideTurnTransition('continuing', { kind: 'failed' })).toThrow();
});

it('any state + abort_resolution_required throws', () => {
  const controlOutcome = {
    kind: 'abort_resolution_required' as const,
    abortedContext: { token: 1, method: 'confirm' as const } as any,
    userText: 'cancel',
    generation: 1,
  };
  expect(() => decideTurnTransition('streaming', controlOutcome)).toThrow(/is not allowed in transition rules/);
  expect(() => decideTurnTransition('continuing', controlOutcome)).toThrow(/is not allowed in transition rules/);
  expect(() => decideTurnTransition('idle', controlOutcome)).toThrow(/is not allowed in transition rules/);
});

it('any state + auto_approval_required throws', () => {
  const controlOutcome = {
    kind: 'auto_approval_required' as const,
    generation: 1,
  };
  expect(() => decideTurnTransition('streaming', controlOutcome)).toThrow(/is not allowed in transition rules/);
  expect(() => decideTurnTransition('continuing', controlOutcome)).toThrow(/is not allowed in transition rules/);
  expect(() => decideTurnTransition('idle', controlOutcome)).toThrow(/is not allowed in transition rules/);
});
