import { it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalFlowCoordinator as ProductionApprovalFlowCoordinator } from './approval-flow-coordinator.js';
import { ApprovalState } from './approval-state.js';
import { ToolOwnershipRegistry } from './tool-ownership-registry.js';
import { PARENT_TOOL_OWNER } from './tool-owner.js';
import { LoggingService } from '../logging/logging-service.js';
import {
  resetSandboxDeniedReadStoresForTest,
  getProjectAllowReadStore,
} from '../../utils/shell/sandbox/denied-read-stores.js';
import type { DeniedReadInfo } from '../../utils/shell/sandbox/denied-read-detector.js';
import { sessionReadAccess } from './session-read-access.js';
import {
  consumeDockerHostControlOnce,
  hasDockerHostControlSession,
  resetDockerHostControlGrantsForTests,
} from '../../utils/shell/sandbox/docker-host-control-grants.js';
import { SessionAccessState } from '../session/session-access-state.js';
import { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';

class ApprovalFlowCoordinator extends ProductionApprovalFlowCoordinator {
  constructor(
    deps: Omit<ConstructorParameters<typeof ProductionApprovalFlowCoordinator>[0], 'toolOwnership'> & {
      toolOwnership?: ToolOwnershipRegistry;
    },
  ) {
    super({
      ...deps,
      toolOwnership: deps.toolOwnership ?? new ToolOwnershipRegistry(),
      nestedCompatibility: deps.nestedCompatibility ?? makeNestedCompatibility(),
    });
  }
}

const SENSITIVE_PATH = '/home/testuser/.ssh/id_rsa';
const SENSITIVE_SUGGESTED = '/home/testuser/.ssh';
const NON_SENSITIVE_PATH = '/home/testuser/.cargo/registry/cache/index';
const NON_SENSITIVE_SUGGESTED = '/home/testuser/.cargo';

const makeDeniedReadInfo = (
  deniedPath = NON_SENSITIVE_PATH,
  suggestedParent = NON_SENSITIVE_SUGGESTED,
  sensitive = false,
): DeniedReadInfo => ({ path: deniedPath, suggestedParent, sensitive });

const SHELL_COMMAND = 'cargo build';

const makeNestedCompatibility = () =>
  new NestedToolCompatibilityState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));

function setupDeniedReadPending(info: DeniedReadInfo = makeDeniedReadInfo()) {
  const nestedCompatibility = makeNestedCompatibility();
  nestedCompatibility.deniedReads.stageForDescriptor(SHELL_COMMAND, info);
  let approved = false;
  let rejected = false;
  const state: any = {
    approve: () => (approved = true),
    reject: () => (rejected = true),
  };
  const interruption = { name: 'shell', callId: 'dr1', arguments: JSON.stringify({ command: SHELL_COMMAND }) };
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
    sessionId: 'dr-test',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });
  return { coord, state, nestedCompatibility, getApproved: () => approved, getRejected: () => rejected };
}

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  resetSandboxDeniedReadStoresForTest();
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-dr-test-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  resetSandboxDeniedReadStoresForTest();
  resetDockerHostControlGrantsForTests();
  sessionReadAccess.clear('s1');
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const logger = new LoggingService({ disableLogging: true });
const mockToolTracker: any = {
  recordAbortedApproval: () => {},
  markOpenCallsAborted: () => {},
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
  const toolOwnership = new ToolOwnershipRegistry();
  toolOwnership.claim(['abort-call'], { kind: 'subagent', agentId: 'worker-1', role: 'worker' });
  approvalState.setPending({
    state: {} as any,
    interruption: { callId: 'abort-call' },
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
    toolOwnership,
  });

  const result = coord.abort();
  expect(abortCalled).toBe(true);
  expect(result.aborted).toBe(true);
  expect(toolOwnership.ownerOf('abort-call')).toEqual(PARENT_TOOL_OWNER);
});

it('abort with a pending approval aborts the foreground stream without cancelling background runs', () => {
  let abortCalled = false;
  let cancelBackgroundCalled = false;
  const client: any = {
    abort: () => (abortCalled = true),
    cancelBackgroundRuns: () => (cancelBackgroundCalled = true),
  };
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
  expect(cancelBackgroundCalled).toBe(false);
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

it('buildApprovalDecision uses the pending generation token', () => {
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: {} as any,
    interruption: {},
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
    token: 7,
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

  expect(coord.buildApprovalDecision('n', 'too risky')).toEqual({
    kind: 'approval_decision',
    answer: 'n',
    rejectionReason: 'too risky',
    generation: 7,
  });
});

it('buildApprovalDecision falls back to generation 0 when nothing is pending', () => {
  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
  });

  expect(coord.buildApprovalDecision('y', undefined)).toEqual({
    kind: 'approval_decision',
    answer: 'y',
    rejectionReason: undefined,
    generation: 0,
  });
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

it('prepareContinuation rejects a generic approval for Docker host control without granting access', () => {
  let approved = false;
  let rejected = false;
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { approve: () => (approved = true), reject: () => (rejected = true) } as any,
    interruption: { name: 'shell', callId: 'docker-y', arguments: { command: 'docker ps' } },
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

  coord.prepareContinuation('y', undefined);

  expect(approved).toBe(false);
  expect(rejected).toBe(true);
  expect(consumeDockerHostControlOnce('s1', 'docker ps')).toBe(false);
});

it('prepareContinuation stages but does not consume an explicit nested Docker one-shot grant', () => {
  let approved = false;
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { approve: () => (approved = true) } as any,
    interruption: { name: 'shell', callId: 'docker-1', arguments: { command: 'docker ps' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  const { client } = makeMockAgentClient();
  const nestedCompatibility = makeNestedCompatibility();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });

  coord.prepareContinuation('docker-allow-once', undefined);

  expect(approved).toBe(true);
  expect(nestedCompatibility.docker.consumeOnce('s1', 'docker ps')).toBe(true);
});

it('prepareContinuation grants nested Docker host control to a command the sandbox blocked from the daemon', () => {
  let approved = false;
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { approve: () => (approved = true) } as any,
    interruption: { name: 'shell', callId: 'blocked-1', arguments: { command: 'pnpm test' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  const { client } = makeMockAgentClient();
  const nestedCompatibility = makeNestedCompatibility();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });
  nestedCompatibility.docker.recordDenial('s1', 'pnpm test');

  coord.prepareContinuation('docker-allow-once', undefined);

  expect(approved).toBe(true);
  expect(nestedCompatibility.docker.consumeOnce('s1', 'pnpm test')).toBe(true);
  // The pending block must survive approval: for a command that does not read as
  // Docker, it is what tells the resumed execution to take host control.
  expect(nestedCompatibility.docker.requiresApproval('s1', 'pnpm test')).toBe(true);
});

it('prepareContinuation classifies an indirect Docker denial from injected access state', () => {
  let approved = false;
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { approve: () => (approved = true) } as any,
    interruption: {
      name: 'shell',
      callId: 'owned-blocked',
      arguments: { command: 'indirect-command' },
    },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  const access = new SessionAccessState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));
  access.recordDockerDenial('indirect-command');
  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    sessionAccess: access,
  });

  coord.prepareContinuation('docker-allow-once', undefined);

  expect(approved).toBe(true);
  expect(access.hasDockerGrant('indirect-command', process.cwd())).toBe(true);
});

it('prepareContinuation clears the pending nested Docker request when the user denies it', () => {
  let rejected = false;
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { reject: () => (rejected = true) } as any,
    interruption: { name: 'shell', callId: 'blocked-2', arguments: { command: 'pnpm test' } },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });
  const { client } = makeMockAgentClient();
  const nestedCompatibility = makeNestedCompatibility();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });
  nestedCompatibility.docker.recordDenial('s1', 'pnpm test');

  coord.prepareContinuation('n', 'no docker');

  expect(rejected).toBe(true);
  expect(nestedCompatibility.docker.requiresApproval('s1', 'pnpm test')).toBe(false);
});

it('prepareContinuation rejects Docker-specific answers for non-Docker commands', () => {
  let rejected = false;
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { reject: () => (rejected = true) } as any,
    interruption: { name: 'shell', callId: 'not-docker', arguments: { command: 'git status' } },
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

  coord.prepareContinuation('docker-allow-session', undefined);

  expect(rejected).toBe(true);
  expect(hasDockerHostControlSession('s1', process.cwd())).toBe(false);
});

it('prepareContinuation allow-folder-session allows the read file parent recursively in nested compatibility state', () => {
  let approved = false;
  const state: any = { approve: () => (approved = true) };
  const approvalState = new ApprovalState();
  const filePath = path.join(tmpDir, 'docs', 'guide.md');
  approvalState.setPending({
    state,
    interruption: { name: 'read_file', callId: 'read-1', arguments: JSON.stringify({ path: filePath }) },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const nestedCompatibility = makeNestedCompatibility();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });

  coord.prepareContinuation('allow-folder-session', undefined);

  expect(approved).toBe(true);
  expect(nestedCompatibility.allowsRead('s1', path.join(tmpDir, 'docs', 'nested', 'other.md'))).toBe(true);
  expect(nestedCompatibility.allowsRead('s1', path.join(tmpDir, 'sibling', 'other.md'))).toBe(false);
});

it('prepareContinuation allow-folder-session grants the searched directory itself for grep', () => {
  let approved = false;
  const state: any = { approve: () => (approved = true) };
  const approvalState = new ApprovalState();
  const searchDir = path.join(tmpDir, 'docs');
  fs.mkdirSync(searchDir, { recursive: true });
  approvalState.setPending({
    state,
    interruption: {
      name: 'grep',
      callId: 'grep-1',
      arguments: JSON.stringify({ pattern: 'needle', path: searchDir }),
    },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const nestedCompatibility = makeNestedCompatibility();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });

  coord.prepareContinuation('allow-folder-session', undefined);

  expect(approved).toBe(true);
  // The directory the user approved, not its parent.
  expect(nestedCompatibility.allowsRead('s1', path.join(searchDir, 'nested', 'other.md'))).toBe(true);
  expect(nestedCompatibility.allowsRead('s1', path.join(tmpDir, 'sibling', 'other.md'))).toBe(false);
});

it('prepareContinuation allow-folder-session grants the directory of an absolute glob pattern', () => {
  let approved = false;
  const state: any = { approve: () => (approved = true) };
  const approvalState = new ApprovalState();
  const searchDir = path.join(tmpDir, 'models');
  fs.mkdirSync(searchDir, { recursive: true });
  approvalState.setPending({
    state,
    interruption: {
      name: 'glob',
      callId: 'glob-1',
      arguments: JSON.stringify({ pattern: path.join(searchDir, 'run_*.sh') }),
    },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const nestedCompatibility = makeNestedCompatibility();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    nestedCompatibility,
  });

  coord.prepareContinuation('allow-folder-session', undefined);

  expect(approved).toBe(true);
  expect(nestedCompatibility.allowsRead('s1', path.join(searchDir, 'run_a.sh'))).toBe(true);
});

it('prepareContinuation allow-folder-session from a read_file prompt also covers grep and glob', () => {
  const state: any = { approve: () => undefined };
  const approvalState = new ApprovalState();
  const filePath = path.join(tmpDir, 'docs', 'guide.md');
  approvalState.setPending({
    state,
    interruption: { name: 'read_file', callId: 'read-2', arguments: JSON.stringify({ path: filePath }) },
    emittedCommandIds: new Set(),
    toolCallArgumentsById: new Map(),
  });

  const { client } = makeMockAgentClient();
  const sessionAccess = new SessionAccessState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState,
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    sessionAccess,
  });

  coord.prepareContinuation('allow-folder-session', undefined);

  // The grant is one session-scoped folder set, consulted by every read-only tool.
  expect(sessionAccess.allowsRead(path.join(tmpDir, 'docs'))).toBe(true);
  expect(sessionAccess.allowsRead(path.join(tmpDir, 'docs', 'sub', 'deep.ts'))).toBe(true);
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

it('prepareContinuation rejection: nested subagent where state.reject is undefined — does not throw', () => {
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
  expect(plan.abortedContext).toBe(aborted);
});

it('keeps a call released when abort resolution rejects the aborted continuation', () => {
  const toolOwnership = new ToolOwnershipRegistry();
  toolOwnership.claim(['abort-resolution-call'], { kind: 'subagent', agentId: 'worker-1', role: 'worker' });
  const approvalState = new ApprovalState();
  approvalState.setPending({
    state: { reject: () => undefined } as any,
    interruption: { name: 'shell', callId: 'abort-resolution-call', arguments: { command: 'pwd' } },
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
    toolOwnership,
  });

  expect(coord.abort()).toMatchObject({ aborted: true, callId: 'abort-resolution-call' });
  const aborted = coord.consumeAborted();
  expect(aborted).not.toBeNull();
  coord.prepareAbortResolution(aborted!, 'a new question');

  expect(toolOwnership.ownerOf('abort-resolution-call')).toEqual(PARENT_TOOL_OWNER);
  expect(toolOwnership.size).toBe(0);
});

it('retargetPendingInterruption preserves batch context', () => {
  const approvalState = new ApprovalState();
  const state = { id: 'state-1' } as any;
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
    toolOwnership: new ToolOwnershipRegistry(),
  });
  const nextInterruption = { name: 'shell', callId: 'call-2', arguments: { command: 'ls' } };

  const pending = coord.retargetPendingInterruption(nextInterruption);

  expect(pending?.interruption).toBe(nextInterruption);
  expect(pending?.state).toBe(state);
  expect(pending?.emittedCommandIds).toEqual(new Set(['message-1']));
  expect(pending?.toolCallArgumentsById).toEqual(new Map([['call-1', { command: 'pwd' }]]));
});

it('retargetPendingInterruption re-resolves the owner for the newly targeted call', () => {
  // Within one approval batch a parent-owned call and a subagent-owned call can
  // sit side by side; retargeting must move ownership with the interruption.
  const approvalState = new ApprovalState();
  const toolOwnership = new ToolOwnershipRegistry();
  toolOwnership.claim(['call-2'], { kind: 'subagent', agentId: 'worker-1', role: 'worker' });
  approvalState.setPending({
    state: { id: 'state-1' } as any,
    interruption: { name: 'shell', callId: 'call-1', arguments: { command: 'pwd' } },
    emittedCommandIds: new Set<string>(),
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
    toolOwnership,
  });

  expect(coord.getPending()?.owner).toEqual(PARENT_TOOL_OWNER);

  const pending = coord.retargetPendingInterruption({
    name: 'shell',
    callId: 'call-2',
    arguments: { command: 'ls' },
  });

  expect(pending?.owner).toEqual({ kind: 'subagent', agentId: 'worker-1', role: 'worker' });
});

it('resolveOwner attributes an unclaimed interruption to the parent', () => {
  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    toolOwnership: new ToolOwnershipRegistry(),
  });

  expect(coord.resolveOwner({ name: 'shell', callId: 'unclaimed' })).toEqual(PARENT_TOOL_OWNER);
});

it('resolveOwner reads the call id out of a nested rawItem', () => {
  const toolOwnership = new ToolOwnershipRegistry();
  toolOwnership.claim(['nested-call'], { kind: 'subagent', agentId: 'explorer-1', role: 'explorer' });
  const { client } = makeMockAgentClient();
  const coord = new ApprovalFlowCoordinator({
    agentClient: client,
    approvalState: new ApprovalState(),
    logger,
    sessionId: 's1',
    toolTracker: mockToolTracker,
    generationGuard: mockGenerationGuard,
    toolOwnership,
  });

  expect(coord.resolveOwner({ name: 'shell', rawItem: { callId: 'nested-call' } })).toEqual({
    kind: 'subagent',
    agentId: 'explorer-1',
    role: 'explorer',
  });
});

// --- Denied-read approval decision tests ---

it('prepareContinuation allow-once sets nested execution override with extraAllowRead and approves', () => {
  const { coord, nestedCompatibility, getApproved } = setupDeniedReadPending(makeDeniedReadInfo());
  const plan = coord.prepareContinuation('allow-once', undefined);
  expect(plan).toBeTruthy();
  expect(getApproved()).toBe(true);
  const override = nestedCompatibility.executionOverrides.consume(SHELL_COMMAND);
  expect(override).toEqual({ extraAllowRead: [NON_SENSITIVE_SUGGESTED] });
});

it('prepareContinuation unsandboxed-once sets nested forceUnsandboxed override and approves', () => {
  const { coord, nestedCompatibility, getApproved } = setupDeniedReadPending(makeDeniedReadInfo());
  const plan = coord.prepareContinuation('unsandboxed-once', undefined);
  expect(plan).toBeTruthy();
  expect(getApproved()).toBe(true);
  const override = nestedCompatibility.executionOverrides.consume(SHELL_COMMAND);
  expect(override).toEqual({ forceUnsandboxed: true });
});

it('prepareContinuation allow-remember persists path from nested state to the project store and approves', () => {
  const { coord, nestedCompatibility, getApproved } = setupDeniedReadPending(makeDeniedReadInfo());
  const plan = coord.prepareContinuation('allow-remember', undefined);
  expect(plan).toBeTruthy();
  expect(getApproved()).toBe(true);
  const override = nestedCompatibility.executionOverrides.consume(SHELL_COMMAND);
  expect(override).toEqual({ extraAllowRead: [NON_SENSITIVE_SUGGESTED] });
  // The path is persisted in the project store for future loads.
  expect(getProjectAllowReadStore(process.cwd()).load()).toEqual([NON_SENSITIVE_SUGGESTED]);
});

it('prepareContinuation denied-read approval without staged metadata approves without sandbox override', () => {
  const { coord, nestedCompatibility, getApproved } = setupDeniedReadPending(makeDeniedReadInfo());
  nestedCompatibility.deniedReads.consumeStaged(SHELL_COMMAND);

  const plan = coord.prepareContinuation('allow-remember', undefined);

  expect(plan).toBeTruthy();
  expect(getApproved()).toBe(true);
  expect(nestedCompatibility.executionOverrides.consume(SHELL_COMMAND)).toBeNull();
  expect(getProjectAllowReadStore(process.cwd()).load()).toEqual([]);
});

it('prepareContinuation deny calls state.reject and sets no override', () => {
  const { coord, nestedCompatibility, getApproved, getRejected } = setupDeniedReadPending(makeDeniedReadInfo());
  const plan = coord.prepareContinuation('deny', undefined);
  expect(plan).toBeTruthy();
  expect(getApproved()).toBe(false);
  expect(getRejected()).toBe(true);
  // No override is set — the agent gets the rejection.
  expect(nestedCompatibility.executionOverrides.consume(SHELL_COMMAND)).toBeNull();
  // The staged denied-read info lingers but is harmless (cleared on the next
  // denied-read detection or on session reset). Deny goes through the generic
  // rejection branch, which does not clean up denied-read-specific state.
});

it('prepareContinuation allow-once for a sensitive nested path still sets the override', () => {
  const { coord, nestedCompatibility, getApproved } = setupDeniedReadPending(
    makeDeniedReadInfo(SENSITIVE_PATH, SENSITIVE_SUGGESTED, true),
  );
  const plan = coord.prepareContinuation('allow-once', undefined);
  expect(plan).toBeTruthy();
  expect(getApproved()).toBe(true);
  const override = nestedCompatibility.executionOverrides.consume(SHELL_COMMAND);
  expect(override).toEqual({ extraAllowRead: [SENSITIVE_SUGGESTED] });
});
