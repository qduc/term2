import { it, expect } from 'vitest';
import { SubagentBridge as ProductionSubagentBridge } from './subagent-bridge.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { createOpencodeSessionInjector } from '../providers/opencode-session.js';
import { SubagentAsyncRegistry } from '../services/subagents/subagent-async-registry.js';

/**
 * The seam this file guards: `SubagentBridge` (foreground runs) and
 * `SubagentAsyncRegistry` (background runs) decide *what* a nested run is — its
 * provider history key — and the opencode injector decides *which* session
 * header that becomes. Unit tests on either side can both pass while a subagent
 * still ends up sharing the parent conversation's OpenCode session — which is
 * how that bug shipped. These tests drive both sides together.
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

function makeHarness() {
  const sessionContextService = new SessionContextService();

  // Mirrors production wiring: the wrapper is built once for the conversation,
  // so its override is conversation-scoped.
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    { sessionContextService, fallbackSessionIdOverride: 'ses_conversation1234567890abcd' },
  )!;

  const currentSessionHeader = (): string => {
    const headers = injector({})!.headers as Record<string, string>;
    const key = Object.keys(headers).find((k) => k.toLowerCase() === 'x-opencode-session')!;
    return headers[key];
  };

  const observed: string[] = [];
  const record = () => {
    observed.push(currentSessionHeader());
    return { finalText: '', status: 'completed', toolsUsed: [], filesChanged: [] };
  };

  const manager = {
    run: async () => record(),
    runAsTool: async () => record(),
    resetMentorSession: () => {},
    clearCache: () => {},
  };

  const bridge = new ProductionSubagentBridge({
    logger: noopLogger as any,
    settings: { get: () => undefined, set: () => {} } as any,
    sessionContextService: sessionContextService as any,
    chat: async () => '',
    createClient: () => ({}),
    subagentManager: manager as any,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  return { bridge, sessionContextService, currentSessionHeader, observed };
}

const conversationContext = {
  sessionId: 'session-1',
  sessionStartedAt: '2026-06-21T14:20:00.000Z',
};

it('foreground subagent requests carry an OpenCode session distinct from the parent conversation', async () => {
  const { bridge, sessionContextService, currentSessionHeader, observed } = makeHarness();

  const parentHeader = await sessionContextService.runWithContext(conversationContext as any, async () => {
    const header = currentSessionHeader();
    await bridge.createMentor('why');
    await bridge.runSubagent({ role: 'worker', task: 'a' }, undefined, { toolCall: { callId: 'call-a' } });
    await bridge.runSubagent({ role: 'worker', task: 'b' }, undefined, { toolCall: { callId: 'call-b' } });
    return header;
  });

  expect(parentHeader).toBe('ses_conversation1234567890abcd');
  expect(observed).toHaveLength(3);
  for (const header of observed) {
    expect(header, 'a subagent must not reuse the conversation session').not.toBe(parentHeader);
    expect(header).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  }
  expect(new Set(observed).size, 'each subagent run needs its own session').toBe(3);
});

it('the same subagent run keeps one OpenCode session across its requests', async () => {
  const { bridge, sessionContextService, currentSessionHeader, observed } = makeHarness();

  await sessionContextService.runWithContext(conversationContext as any, async () => {
    await bridge.runSubagent({ role: 'worker', task: 'a' }, undefined, { toolCall: { callId: 'call-a' } });
    // A second request from inside the same run resolves the header again.
    await bridge.runSubagent({ role: 'worker', task: 'a' }, undefined, { toolCall: { callId: 'call-a' } });
  });

  expect(observed[0]).toBe(observed[1]);
});

it('a background run keeps one OpenCode session from launch through continuation', async () => {
  // Background runs are scoped by the registry, not the bridge: it owns the run
  // ID, which is the only identity shared by a launch and its continuations.
  const sessionContextService = new SessionContextService();
  const injector = createOpencodeSessionInjector(
    { type: 'opencode' },
    { sessionContextService, fallbackSessionIdOverride: 'ses_conversation1234567890abcd' },
  )!;
  const readHeader = (): string => {
    const headers = injector({})!.headers as Record<string, string>;
    return headers[Object.keys(headers).find((k) => k.toLowerCase() === 'x-opencode-session')!];
  };

  const observed: string[] = [];
  const registry = new SubagentAsyncRegistry({
    logger: noopLogger as any,
    sessionContextService,
    run: async ({ request, runId }) => {
      observed.push(readHeader());
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

  const parentHeader = sessionContextService.runWithContext(conversationContext as any, () => readHeader());

  const handle = sessionContextService.runWithContext(conversationContext as any, () =>
    registry.startRun({ role: 'explorer', task: 'c' }),
  );
  await registry.getResult(handle.runId);

  // The continuation arrives on a later turn, from a different tool call.
  sessionContextService.runWithContext(conversationContext as any, () =>
    registry.startRun({ role: 'explorer', task: 'more', continueRunId: handle.runId }),
  );
  await registry.getResult(handle.runId);

  expect(observed).toHaveLength(2);
  expect(observed[0]).not.toBe(parentHeader);
  expect(observed[1], 'a continuation must rejoin its own session').toBe(observed[0]);
  registry.dispose();
});
