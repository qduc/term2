import { it, expect } from 'vitest';
import { ConversationAdapter } from './conversation-adapter.js';
import type { SessionLogs, SessionApprovalQuery } from '../session/session-composition.js';
import type { SessionManager } from '../session/session-manager.js';

const noop = () => {};

const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
};

const sessionContextService = {
  runWithContext: (_context: any, fn: () => any) => fn(),
  getContext: () => null,
};

// C11-D8 `additive_grant_kind`: the durable approval_resolved event must carry an
// optional, backward-compatible grantKind distinguishing the approval mode. The adapter
// currently emits only `answer: 'y' | 'n'`. Ordinary form observed failure: the captured
// event has no `grantKind` property.
it.fails(
  'emits an additive grantKind on the durable approval_resolved event (C11-D8 additive_grant_kind)',
  async () => {
    const pendingApproval = {
      interruption: { name: 'shell', callId: 'c1', arguments: { command: 'ls' }, agent: { name: 'Agent' } },
      token: 'tok-1',
    };
    const captured: any[] = [];

    const adapter = new ConversationAdapter({
      sessionId: 'session-1',
      startedAt: 'now',
      logger,
      sessionContextService,
      userTurns: { listUserTurns: () => [] } as Pick<SessionManager, 'listUserTurns'>,
      logs: {
        dispatchEventToLog: noop,
        log: (event: any) => captured.push(event),
        setLogSink: noop,
      } as unknown as SessionLogs,
      approval: { getPending: () => pendingApproval } as unknown as SessionApprovalQuery,
      turnFlow: {
        async *continueAfterApproval() {
          yield { type: 'final' as const, finalText: 'done' };
        },
      } as any,
    });

    await adapter.handleApprovalDecision('y');

    const event = captured.find((entry) => entry?.type === 'approval_resolved');
    expect(event).toBeDefined();
    expect(event?.answer).toBe('y');
    expect(event?.grantKind).toBe('interactive');
  },
);
