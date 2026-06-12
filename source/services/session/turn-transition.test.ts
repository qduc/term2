import test from 'ava';
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

test('streaming + response → idle + emit_terminal', (t) => {
  const result = decideTurnTransition('streaming', { kind: 'response', terminal: terminalResponse });
  t.is(result.next, 'idle');
  t.is(result.command.kind, 'emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    t.is(result.command.terminal, terminalResponse);
  }
});

test('streaming + approval_required → awaiting_approval + emit_terminal', (t) => {
  const result = decideTurnTransition('streaming', { kind: 'approval_required', terminal: terminalApproval });
  t.is(result.next, 'awaiting_approval');
  t.is(result.command.kind, 'emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    t.is(result.command.terminal, terminalApproval);
  }
});

test('streaming + stale → streaming + none', (t) => {
  const result = decideTurnTransition('streaming', { kind: 'stale' });
  t.is(result.next, 'streaming');
  t.is(result.command.kind, 'none');
});

test('streaming + failed → idle + none', (t) => {
  const result = decideTurnTransition('streaming', { kind: 'failed' });
  t.is(result.next, 'idle');
  t.is(result.command.kind, 'none');
});

// ── Valid transitions: continuing ──────────────────────────────

test('continuing + response → idle + emit_terminal', (t) => {
  const result = decideTurnTransition('continuing', { kind: 'response', terminal: terminalResponse });
  t.is(result.next, 'idle');
  t.is(result.command.kind, 'emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    t.is(result.command.terminal, terminalResponse);
  }
});

test('continuing + approval_required → awaiting_approval + emit_terminal', (t) => {
  const result = decideTurnTransition('continuing', { kind: 'approval_required', terminal: terminalApproval });
  t.is(result.next, 'awaiting_approval');
  t.is(result.command.kind, 'emit_terminal');
  if (result.command.kind === 'emit_terminal') {
    t.is(result.command.terminal, terminalApproval);
  }
});

test('continuing + stale → continuing + none', (t) => {
  const result = decideTurnTransition('continuing', { kind: 'stale' });
  t.is(result.next, 'continuing');
  t.is(result.command.kind, 'none');
});

test('continuing + fresh_start_required → streaming + re_drive', (t) => {
  const result = decideTurnTransition('continuing', {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
  });
  t.is(result.next, 'streaming');
  t.is(result.command.kind, 're_drive');
  if (result.command.kind === 're_drive') {
    t.true(result.command.options.skipUserMessage);
    t.is(result.command.options.retries, defaultRetryCounts);
    t.is(result.command.options.delayMs, undefined);
    t.is(result.command.options.useStandardServiceTier, undefined);
  }
});

test('continuing + fresh_start_required with delayMs and useStandardServiceTier', (t) => {
  const result = decideTurnTransition('continuing', {
    kind: 'fresh_start_required',
    retryCounts: defaultRetryCounts,
    delayMs: 500,
    useStandardServiceTier: true,
  });
  t.is(result.next, 'streaming');
  t.is(result.command.kind, 're_drive');
  if (result.command.kind === 're_drive') {
    t.true(result.command.options.skipUserMessage);
    t.is(result.command.options.delayMs, 500);
    t.is(result.command.options.useStandardServiceTier, true);
  }
});

// ── Invalid transitions ───────────────────────────────────────

test('idle + any outcome throws', (t) => {
  t.throws(() => decideTurnTransition('idle', { kind: 'stale' }), {
    message: /Invalid transition from idle/,
  });
  t.throws(() => decideTurnTransition('idle', { kind: 'failed' }), {
    message: /Invalid transition from idle/,
  });
  t.throws(() => decideTurnTransition('idle', { kind: 'response', terminal: terminalResponse }), {
    message: /Invalid transition from idle/,
  });
});

test('awaiting_approval + any outcome throws', (t) => {
  t.throws(() => decideTurnTransition('awaiting_approval', { kind: 'stale' }), {
    message: /Invalid transition from awaiting_approval/,
  });
  t.throws(() => decideTurnTransition('awaiting_approval', { kind: 'failed' }), {
    message: /Invalid transition from awaiting_approval/,
  });
  t.throws(() => decideTurnTransition('awaiting_approval', { kind: 'response', terminal: terminalResponse }), {
    message: /Invalid transition from awaiting_approval/,
  });
});

// ── Invalid outcome for state (compile-time checks) ───────────

test('streaming + fresh_start_required throws', (t) => {
  t.throws(() =>
    decideTurnTransition('streaming', {
      kind: 'fresh_start_required',
      retryCounts: defaultRetryCounts,
    }),
  );
});

test('continuing + failed throws', (t) => {
  t.throws(() => decideTurnTransition('continuing', { kind: 'failed' }));
});
