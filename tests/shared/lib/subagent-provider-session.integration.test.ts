import { it, expect } from 'vitest';
import { SessionContextService } from '../../../src/session/session/session-context-service.js';
import { createOpencodeSessionInjector } from '../../../src/model/providers/opencode-session.js';
import { SubagentAsyncRegistry } from '../../../src/tools/subagents/subagent-async-registry.js';

/**
 * The seam this file guards after the legacy SubagentBridge deletion: production
 * nested runs set `providerHistoryKey` (background: SubagentAsyncRegistry) and
 * the OpenCode injector turns that key into `x-opencode-session`. Unit tests on
 * either side can both pass while a subagent still ends up sharing the parent
 * conversation's OpenCode session — which is how that bug shipped. These tests
 * drive the live sides together (no SubagentBridge).
 */

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  security: () => {},
  setCorrelationId: () => {},
  clearCorrelationId: () => {},
  getCorrelationId: () => undefined,
};

const conversationContext = {
  sessionId: 'session-1',
  sessionStartedAt: '2026-06-21T14:20:00.000Z',
};

function makeInjector(sessionContextService: SessionContextService) {
  return createOpencodeSessionInjector(
    { type: 'opencode' },
    { sessionContextService, fallbackSessionIdOverride: 'ses_conversation1234567890abcd' },
  )!;
}

function readHeader(injector: NonNullable<ReturnType<typeof createOpencodeSessionInjector>>): string {
  const headers = injector({})!.headers as Record<string, string>;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-opencode-session')!;
  return headers[key];
}

it('nested providerHistoryKey requests carry an OpenCode session distinct from the parent conversation', async () => {
  const sessionContextService = new SessionContextService();
  const injector = makeInjector(sessionContextService);

  const parentHeader = sessionContextService.runWithContext(conversationContext as any, () => readHeader(injector));

  const observed: string[] = [];
  await sessionContextService.runWithContext(conversationContext as any, async () => {
    for (const scope of ['call-a', 'call-b', 'mentor']) {
      const parentKey = conversationContext.sessionId;
      await sessionContextService.runWithContext(
        { ...conversationContext, providerHistoryKey: `${parentKey}:subagent:${scope}` } as any,
        async () => {
          observed.push(readHeader(injector));
        },
      );
    }
  });

  expect(parentHeader).toBe('ses_conversation1234567890abcd');
  expect(observed).toHaveLength(3);
  for (const header of observed) {
    expect(header, 'a subagent must not reuse the conversation session').not.toBe(parentHeader);
    expect(header).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  }
  expect(new Set(observed).size, 'each subagent run needs its own session').toBe(3);
});

it('the same nested providerHistoryKey keeps one OpenCode session across its requests', async () => {
  const sessionContextService = new SessionContextService();
  const injector = makeInjector(sessionContextService);
  const observed: string[] = [];
  const parentKey = conversationContext.sessionId;
  const nested = { ...conversationContext, providerHistoryKey: `${parentKey}:subagent:call-a` };

  await sessionContextService.runWithContext(conversationContext as any, async () => {
    await sessionContextService.runWithContext(nested as any, async () => {
      observed.push(readHeader(injector));
    });
    await sessionContextService.runWithContext(nested as any, async () => {
      observed.push(readHeader(injector));
    });
  });

  expect(observed[0]).toBe(observed[1]);
});

it('a background run keeps one OpenCode session from launch through continuation', async () => {
  // Background runs are scoped by the registry: it owns the run ID, which is
  // the only identity shared by a launch and its continuations.
  const sessionContextService = new SessionContextService();
  const injector = makeInjector(sessionContextService);
  const observed: string[] = [];
  const registry = new SubagentAsyncRegistry({
    logger: noopLogger as any,
    sessionContextService,
    run: async ({ request, runId }) => {
      observed.push(readHeader(injector));
      return {
        agentId: runId,
        role: request.role,
        status: 'completed',
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
      };
    },
  });

  const parentHeader = sessionContextService.runWithContext(conversationContext as any, () => readHeader(injector));

  const handle = sessionContextService.runWithContext(conversationContext as any, () =>
    registry.startRun({ role: 'explorer', task: 'c' }),
  );
  await registry.getResult(handle.runId);

  sessionContextService.runWithContext(conversationContext as any, () =>
    registry.startRun({ role: 'explorer', task: 'more', continueRunId: handle.runId }),
  );
  await registry.getResult(handle.runId);

  expect(observed).toHaveLength(2);
  expect(observed[0]).not.toBe(parentHeader);
  expect(observed[1], 'a continuation must rejoin its own session').toBe(observed[0]);
  registry.dispose();
});
