import test from 'ava';
import { ApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ApprovalState } from './approval-state.js';
import { LoggingService } from './logging-service.js';

const logger = new LoggingService({ disableLogging: true });

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

test('abort delegates to agentClient and approvalState', (t) => {
  let abortCalled = false;
  const client: any = { abort: () => (abortCalled = true) };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: {},
    interruption: {},
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
  });

  const result = coord.abort();
  t.true(abortCalled);
  t.true(result);
});

test('abort returns false when no pending approval', (t) => {
  const client: any = { abort: () => undefined };
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
  });
  t.false(coord.abort());
});

test('prepareContinuation returns null when no pending approval', (t) => {
  const client: any = {};
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
  });
  t.is(coord.prepareContinuation('y', undefined), null);
});

test('prepareContinuation answer=y emits tool_started and approves', (t) => {
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
  });

  const plan = coord.prepareContinuation('y', undefined);
  t.truthy(plan);
  t.true(approved);
  t.is(plan?.toolStartedEvent?.type, 'tool_started');
  if (plan?.toolStartedEvent?.type === 'tool_started') {
    t.is(plan.toolStartedEvent.toolName, 'shell');
    t.is(plan.toolStartedEvent.toolCallId, 'c1');
  }
});

test('prepareContinuation rejection: with interceptor support, approves with installed interceptor', (t) => {
  let approved = false;
  let rejected = false;
  const state: any = {
    approve: () => (approved = true),
    reject: () => (rejected = true),
  };
  const interruption = { name: 'shell', callId: 'c1', arguments: { command: 'rm -rf /' } };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption,
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client, installs } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
  });

  const plan = coord.prepareContinuation('n', 'too dangerous');
  t.truthy(plan);
  t.true(approved, 'approve is called when interceptor is installed');
  t.false(rejected, 'reject is NOT called when interceptor is available');
  t.is(installs.length, 1, 'one interceptor was installed');
  t.is(plan?.toolStartedEvent, undefined, 'no tool_started for rejection');
});

test('prepareContinuation rejection: without interceptor support, falls back to reject', (t) => {
  let approved = false;
  let rejected = false;
  const state: any = {
    approve: () => (approved = true),
    reject: () => (rejected = true),
  };
  const interruption = { name: 'shell', callId: 'c1', arguments: { command: 'rm -rf /' } };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption,
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  // agentClient lacks addToolInterceptor — interceptor cannot be installed
  const client: any = {};
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
  });

  const plan = coord.prepareContinuation('n', undefined);
  t.truthy(plan);
  t.false(approved);
  t.true(rejected);
});

test('prepareContinuation rejection: nested subagent approval rejects without parent interceptor', (t) => {
  let approved = false;
  let rejected = false;
  const state: any = {
    approve: () => (approved = true),
    reject: () => (rejected = true),
  };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption: { name: 'shell', callId: 'worker-shell', arguments: { command: 'npm test' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    nestedSubagent: true,
  });

  const { client, installs } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
  });

  const plan = coord.prepareContinuation('n', 'do not run it');
  t.truthy(plan);
  t.false(approved);
  t.true(rejected);
  t.is(installs.length, 0);
});

test('prepareContinuation rejection: non-nested with no interceptor support falls back to reject (distinct from nested path)', (t) => {
  // This test verifies that non-nested + no interceptor is handled via a distinct branch
  // (not the same as nested subagent rejection). The observable outcome is:
  //   - reject() is called (not approve())
  //   - no interceptor is installed
  let approved = false;
  let rejected = false;
  const state: any = {
    approve: () => (approved = true),
    reject: () => (rejected = true),
  };
  const interruption = { name: 'shell', callId: 'c1', arguments: { command: 'rm -rf /' } };
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state,
    interruption,
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    // nestedSubagent is NOT set — this is the non-nested path
  });

  // agentClient lacks addToolInterceptor — interceptor cannot be installed
  const noInterceptorClient: any = {};
  const coord = new ApprovalFlowCoordinator({
    agentClient: noInterceptorClient,
    approvalState,
    logger,
    sessionId: 's1',
  });

  const plan = coord.prepareContinuation('n', undefined);
  t.truthy(plan);
  t.false(approved, 'approve should not be called when interceptor cannot be installed');
  t.true(rejected, 'non-nested rejection without interceptor support falls back to reject');
});

test('prepareContinuation rejection: nested subagent where state.reject is undefined — does not throw', (t) => {
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
    nestedSubagent: true,
  });

  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
  });

  // Should not throw — reject is optional-chained in the implementation
  t.notThrows(() => {
    coord.prepareContinuation('n', undefined);
  });
});

test('prepareAbortResolution installs interceptor and approves', (t) => {
  let approved = false;
  const state: any = { approve: () => (approved = true) };
  const aborted = {
    state,
    interruption: { name: 'shell', callId: 'c1', arguments: { command: 'ls' } },
    emittedCommandIds: new Set<string>(),
    toolCallArgumentsById: new Map(),
  };

  const { client, installs } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
  });

  const plan = coord.prepareAbortResolution(aborted, 'a new question');
  t.true(approved);
  t.is(installs.length, 1);
  t.is(typeof plan.removeInterceptor, 'function');
});
