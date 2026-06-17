import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ApprovalState } from './approval-state.js';
import { LoggingService } from '../logging/logging-service.js';

const logger = new LoggingService({ disableLogging: true });
const mockToolTracker: any = {
  recordAbortedApproval: () => {},
  export: () => [],
};
const mockGenerationGuard: any = {
  isCurrent: () => true,
  capture: () => 1,
};

const makeMockAgentClient = () => {
  const installs: any[] = [];
  const removes: number[] = [];
  let installCounter = 0;
  const client: any = {
    abort: () => undefined,
    addToolInterceptor: (interceptor: any) => {
      installCounter++;
      installs.push(interceptor);
      const id = installCounter;
      return () => {
        removes.push(id);
      };
    },
  };
  return { client, installs, removes };
};

it('abort delegates to agentClient and approvalState', () => {
  let abortCalled = false;
  const client: any = { abort: () => (abortCalled = true) };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: {} as any,
    interruption: {},
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const result = coord.abort();
  expect(abortCalled).toBe(true);
  expect(result.aborted).toBe(true);
});

it('abort returns false when no pending approval', () => {
  const client: any = { abort: () => undefined };
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });
  expect(coord.abort().aborted).toBe(false);
});

it('prepareContinuation returns null when no pending approval', () => {
  const client: any = {};
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });
  expect(coord.prepareContinuation('y', undefined)).toBe(null);
});

it('prepareContinuation answer=y emits tool_started and approves', () => {
  let approved = false;
  const state: any = { approve: () => (approved = true) };
  const interruption = { name: 'shell', callId: 'c1', arguments: { command: 'ls' } };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption,
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const plan = coord.prepareContinuation('y', undefined);
  expect(plan).toBeTruthy();
  expect(approved).toBe(true);
  expect(plan?.toolStartedEvent?.type).toBe('tool_started');
  if (plan?.toolStartedEvent?.type === 'tool_started') {
    expect(plan.toolStartedEvent.toolName).toBe('shell');
    expect(plan.toolStartedEvent.toolCallId).toBe('c1');
  }
});

it('prepareContinuation answer=y normalizes JSON string tool_started arguments', () => {
  const state: any = { approve: () => undefined };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption: { name: 'shell', callId: 'c-json', arguments: JSON.stringify({ command: 'npm test' }) },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const plan = coord.prepareContinuation('y', undefined);
  expect(plan?.toolStartedEvent?.type).toBe('tool_started');
  if (plan?.toolStartedEvent?.type === 'tool_started') {
    expect(plan.toolStartedEvent.arguments).toEqual({ command: 'npm test' });
  }
});

it('prepareContinuation answer=y emits subagent_tool_started for subagent ownership', () => {
  const state: any = { approve: () => undefined };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption: { name: 'shell', callId: 'nested-c1', arguments: JSON.stringify({ command: 'npm test' }) },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    owner: { kind: 'subagent', agentId: 'worker-1', role: 'worker' },
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const plan = coord.prepareContinuation('y', undefined);
  expect(plan?.toolStartedEvent).toEqual({
    type: 'subagent_tool_started',
    agentId: 'worker-1',
    role: 'worker',
    toolCallId: 'nested-c1',
    toolName: 'shell',
    arguments: { command: 'npm test' },
  });
});

it('prepareContinuation rejection calls state.reject with the correct rejection message', () => {
  let approved = false;
  let rejectedInterruption: any = null;
  let rejectedOptions: any = null;
  const state: any = {
    approve: () => (approved = true),
    reject: (interruption: any, options?: any) => {
      rejectedInterruption = interruption;
      rejectedOptions = options;
    },
  };
  const interruption = { name: 'shell', callId: 'c1', arguments: { command: 'rm -rf /' } };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption,
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const plan = coord.prepareContinuation('n', 'too dangerous');
  expect(plan).toBeTruthy();
  expect(approved).toBe(false);
  expect(rejectedInterruption).toBe(interruption);
  expect(rejectedOptions).toEqual({ message: "Tool execution was not approved. User's reason: too dangerous" });
});

it('prepareContinuation rejection for nested subagent calls state.reject with the correct rejection message', () => {
  let approved = false;
  let rejectedInterruption: any = null;
  let rejectedOptions: any = null;
  const state: any = {
    approve: () => (approved = true),
    reject: (interruption: any, options?: any) => {
      rejectedInterruption = interruption;
      rejectedOptions = options;
    },
  };
  const interruption = { name: 'shell', callId: 'worker-shell', arguments: { command: 'npm test' } };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption,
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    owner: { kind: 'subagent', agentId: 'worker-1', role: 'worker' },
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const plan = coord.prepareContinuation('n', 'do not run it');
  expect(plan).toBeTruthy();
  expect(approved).toBe(false);
  expect(rejectedInterruption).toBe(interruption);
  expect(rejectedOptions).toEqual({ message: "Tool execution was not approved. User's reason: do not run it" });
});

it('prepareContinuation rejection: nested subagent where state.reject is undefined — does not throw', (t) => {
  // state has no reject method — simulates SDK state that only has approve
  const state: any = {
    approve: () => undefined,
    // reject is intentionally absent
  };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption: { name: 'shell', callId: 'nested-c1', arguments: { command: 'ls' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    owner: { kind: 'subagent', agentId: 'worker-1', role: 'worker' },
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  // Should not throw — reject is optional-chained in the implementation
  expect(() => {
    coord.prepareContinuation('n', undefined);
  }).not.toThrow();
});

it('prepareAbortResolution calls state.reject with the correct rejection message', () => {
  let rejectedInterruption: any = null;
  let rejectedOptions: any = null;
  const state: any = {
    reject: (interruption: any, options?: any) => {
      rejectedInterruption = interruption;
      rejectedOptions = options;
    },
  };
  const aborted = {
    state,
    interruption: { name: 'shell', callId: 'c1', arguments: { command: 'ls' } },
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: new Map(),
    owner: { kind: 'parent' as const },
  };

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  const plan = coord.prepareAbortResolution(aborted, 'a new question');
  expect(rejectedInterruption).toBe(aborted.interruption);
  expect(rejectedOptions).toEqual({
    message: 'Tool execution was not approved. User provided new input instead: a new question',
  });
  expect(typeof plan.removeInterceptor).toBe('function');
});

it('retargetPendingInterruption preserves batch context', () => {
  const approvalState = new ApprovalState();
  const state = { _pendingAgentToolRuns: new Map() } as any;
  approvalState.setPending({
    state,
    interruption: { name: 'shell', callId: 'call-1', arguments: { command: 'pwd' } },
    emittedCommandIds: new Set(['message-1']),
    toolCallArgumentsById: new Map([['call-1', { command: 'pwd' }]]),
    inputMode: 'delta',
  });
  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });
  const nextInterruption = { name: 'shell', callId: 'call-2', arguments: { command: 'ls' } };

  const pending = coord.retargetPendingInterruption(nextInterruption);

  expect(pending?.interruption).toBe(nextInterruption);
  expect(pending?.state).toBe(state);
  expect(pending?.emittedCommandIds).toEqual(new Set(['message-1']));
  expect(pending?.toolCallArgumentsById).toEqual(new Map([['call-1', { command: 'pwd' }]]));
});
