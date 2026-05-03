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
