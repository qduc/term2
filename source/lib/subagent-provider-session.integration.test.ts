import { it, expect } from 'vitest';
import { SubagentBridge as ProductionSubagentBridge } from './subagent-bridge.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import { ToolOwnershipRegistry } from '../services/approval/tool-ownership-registry.js';
import { createOpencodeSessionInjector } from '../providers/opencode-session.js';

/**
 * The seam this file guards: `SubagentBridge` decides *what* a nested run is
 * (its provider history key) and the opencode injector decides *which* session
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
    startRunAsync: () => {
      record();
      return { runId: 'run-1' };
    },
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

it('subagent requests carry an OpenCode session distinct from the parent conversation', async () => {
  const { bridge, sessionContextService, currentSessionHeader, observed } = makeHarness();

  const parentHeader = await sessionContextService.runWithContext(conversationContext as any, async () => {
    const header = currentSessionHeader();
    await bridge.createMentor('why');
    await bridge.runSubagent({ role: 'worker', task: 'a' }, undefined, { toolCall: { callId: 'call-a' } });
    await bridge.runSubagent({ role: 'worker', task: 'b' }, undefined, { toolCall: { callId: 'call-b' } });
    await bridge.runSubagentAsync({ role: 'explorer', task: 'c' }, undefined, { toolCall: { callId: 'call-c' } });
    return header;
  });

  expect(parentHeader).toBe('ses_conversation1234567890abcd');
  expect(observed).toHaveLength(4);
  for (const header of observed) {
    expect(header, 'a subagent must not reuse the conversation session').not.toBe(parentHeader);
    expect(header).toMatch(/^ses_[0-9a-f]{12}[0-9a-zA-Z]{14}$/);
  }
  expect(new Set(observed).size, 'each subagent run needs its own session').toBe(4);
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

it('a continued background run rejoins its own OpenCode session', async () => {
  const { bridge, sessionContextService, observed } = makeHarness();

  await sessionContextService.runWithContext(conversationContext as any, async () => {
    await bridge.runSubagentAsync({ role: 'explorer', task: 'c', continue_run_id: 'amber-heron-4' }, undefined, {
      toolCall: { callId: 'call-first' },
    });
    await bridge.runSubagentAsync({ role: 'explorer', task: 'more', continue_run_id: 'amber-heron-4' }, undefined, {
      toolCall: { callId: 'call-second' },
    });
  });

  expect(observed[0]).toBe(observed[1]);
});
