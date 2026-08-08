import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContinuationHandle } from '../../contracts/continuation-handle.js';
import {
  getProjectAllowReadStore,
  resetSandboxDeniedReadStoresForTest,
} from '../../utils/shell/sandbox/denied-read-stores.js';
import { ApprovalDecisionExecutor } from './approval-decision-executor.js';
import type { PendingApprovalContext } from './approval-state.js';
import { NestedToolCompatibilityState } from '../session/nested-tool-compatibility-state.js';
import { SessionAccessState } from '../session/session-access-state.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import type { HookLifecyclePort } from '../hooks/hook-service.js';

const sessionId = 'approval-executor-test';

const makeNestedCompatibility = () =>
  new NestedToolCompatibilityState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));

const makeSessionAccess = () =>
  new SessionAccessState(createMockSettingsService({ 'sandbox.dockerHostControlProjects': [] }));

const makePending = (
  interruption: unknown,
  callbacks: {
    approve?: (interruption: unknown) => void;
    reject?: (interruption: unknown, options?: { message?: string }) => void;
  } = {},
  owner: PendingApprovalContext['owner'] = { kind: 'parent' },
): PendingApprovalContext => ({
  state: createContinuationHandle(callbacks),
  interruption,
  emittedCommandIds: new Set(),
  toolCallArgumentsById: new Map(),
  owner,
});

function createExecutor(
  options: Partial<Omit<ConstructorParameters<typeof ApprovalDecisionExecutor>[0], 'logger' | 'sessionId'>> = {},
) {
  return new ApprovalDecisionExecutor({
    logger: {
      getCorrelationId: () => 'trace-test',
      debug: () => undefined,
      error: () => undefined,
      security: () => undefined,
    } as any,
    sessionId,
    ...options,
  });
}

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  resetSandboxDeniedReadStoresForTest();
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-approval-executor-'));
  process.chdir(tmpDir);
});

afterEach(() => {
  resetSandboxDeniedReadStoresForTest();
  process.chdir(originalCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ApprovalDecisionExecutor', () => {
  it('approves the exact continuation and projects a subagent tool-start event', () => {
    const approved: unknown[] = [];
    const pending = makePending(
      { name: 'shell', callId: 'child-call', arguments: JSON.stringify({ command: 'pnpm test' }) },
      { approve: (interruption) => approved.push(interruption) },
      { kind: 'subagent', agentId: 'worker-1', role: 'worker' },
    );

    const result = createExecutor().resolve({ pendingApprovalContext: pending, answer: 'y' });

    expect(approved).toEqual([pending.interruption]);
    expect(pending.decisionsByCallId).toEqual(new Map([['child-call', 'approved']]));
    expect(result).toMatchObject({
      isApproved: true,
      toolStartedEvent: {
        type: 'subagent_tool_started',
        agentId: 'worker-1',
        role: 'worker',
        toolCallId: 'child-call',
        toolName: 'shell',
        arguments: { command: 'pnpm test' },
      },
    });
  });

  it('rejects the exact continuation with the user reason and records no grants', () => {
    const rejected: Array<{ interruption: unknown; message?: string }> = [];
    const nestedCompatibility = makeNestedCompatibility();
    const command = 'cargo build';
    nestedCompatibility.deniedReads.stageForDescriptor(command, {
      path: '/tmp/blocked/file',
      suggestedParent: '/tmp/blocked',
      sensitive: false,
    });
    const pending = makePending(
      { name: 'shell', callId: 'deny-call', arguments: JSON.stringify({ command }) },
      { reject: (interruption, options) => rejected.push({ interruption, message: options?.message }) },
    );

    const result = createExecutor({ nestedCompatibility }).resolve({
      pendingApprovalContext: pending,
      answer: 'deny',
      rejectionReason: 'not this run',
    });

    expect(result).toMatchObject({ isApproved: false, toolStartedEvent: undefined });
    expect(rejected).toEqual([
      { interruption: pending.interruption, message: "Tool execution was not approved. User's reason: not this run" },
    ]);
    expect(pending.decisionsByCallId).toEqual(new Map([['deny-call', 'rejected']]));
    expect(nestedCompatibility.executionOverrides.consume(command)).toBeNull();
    expect(getProjectAllowReadStore(process.cwd()).load()).toEqual([]);
  });

  it.each([
    ['allow-once', { extraAllowRead: ['/tmp/safe'] }],
    ['unsandboxed-once', { forceUnsandboxed: true }],
  ] as const)('applies denied-read %s override before approving', (answer, expectedOverride) => {
    const nestedCompatibility = makeNestedCompatibility();
    const command = 'cargo build';
    nestedCompatibility.deniedReads.stageForDescriptor(command, {
      path: '/tmp/safe/file',
      suggestedParent: '/tmp/safe',
      sensitive: false,
    });
    const pending = makePending({ name: 'shell', callId: answer, arguments: JSON.stringify({ command }) });

    const result = createExecutor({ nestedCompatibility }).resolve({ pendingApprovalContext: pending, answer });

    expect(result.isApproved).toBe(true);
    expect(nestedCompatibility.executionOverrides.consume(command)).toEqual(expectedOverride);
  });

  it('remembers a denied-read path only for the exact injected compatibility state', () => {
    const nestedCompatibility = makeNestedCompatibility();
    const command = 'cargo build';
    nestedCompatibility.deniedReads.stageForDescriptor(command, {
      path: '/tmp/safe/file',
      suggestedParent: '/tmp/safe',
      sensitive: false,
    });
    const pending = makePending({ name: 'shell', callId: 'remember', arguments: JSON.stringify({ command }) });

    createExecutor({ nestedCompatibility }).resolve({ pendingApprovalContext: pending, answer: 'allow-remember' });

    expect(nestedCompatibility.executionOverrides.consume(command)).toEqual({ extraAllowRead: ['/tmp/safe'] });
    expect(getProjectAllowReadStore(process.cwd()).load()).toEqual(['/tmp/safe']);
  });

  it('approves an unstaged denied-read answer without creating an override or remembered grant', () => {
    const nestedCompatibility = makeNestedCompatibility();
    const command = 'cargo build';
    const pending = makePending({ name: 'shell', callId: 'unstaged', arguments: JSON.stringify({ command }) });

    const result = createExecutor({ nestedCompatibility }).resolve({
      pendingApprovalContext: pending,
      answer: 'allow-remember',
    });

    expect(result.isApproved).toBe(true);
    expect(nestedCompatibility.executionOverrides.consume(command)).toBeNull();
    expect(getProjectAllowReadStore(process.cwd()).load()).toEqual([]);
  });

  it('applies a folder read grant to the exact injected session access state before approving', () => {
    const access = makeSessionAccess();
    const folder = path.join(tmpDir, 'docs');
    const pending = makePending({
      name: 'read_file',
      callId: 'folder',
      arguments: JSON.stringify({ path: path.join(folder, 'guide.md') }),
    });

    const result = createExecutor({ sessionAccess: access }).resolve({
      pendingApprovalContext: pending,
      answer: 'allow-folder-session',
    });

    expect(result.isApproved).toBe(true);
    expect(access.allowsRead(path.join(folder, 'nested', 'note.md'))).toBe(true);
  });

  it('uses nested compatibility state for folder and indirect-Docker approvals', () => {
    const nestedCompatibility = makeNestedCompatibility();
    const folder = path.join(tmpDir, 'docs');
    const folderPending = makePending({
      name: 'glob',
      callId: 'nested-folder',
      arguments: JSON.stringify({ pattern: path.join(folder, '*.md') }),
    });
    const command = 'pnpm test';
    nestedCompatibility.docker.recordDenial(sessionId, command);
    const dockerPending = makePending({
      name: 'shell',
      callId: 'nested-docker',
      arguments: JSON.stringify({ command }),
    });
    const executor = createExecutor({ nestedCompatibility });

    expect(executor.resolve({ pendingApprovalContext: folderPending, answer: 'allow-folder-session' }).isApproved).toBe(
      true,
    );
    expect(executor.resolve({ pendingApprovalContext: dockerPending, answer: 'docker-allow-once' }).isApproved).toBe(
      true,
    );

    expect(nestedCompatibility.allowsRead(sessionId, path.join(folder, 'note.md'))).toBe(true);
    expect(nestedCompatibility.docker.consumeOnce(sessionId, command)).toBe(true);
    expect(nestedCompatibility.docker.requiresApproval(sessionId, command)).toBe(true);
  });

  it.each([
    ['docker-allow-once', 'once'],
    ['docker-allow-session', 'session'],
    ['docker-allow-project', 'project'],
  ] as const)('grants Docker host control with %s only in the injected access state', (answer, scope) => {
    const access = makeSessionAccess();
    const command = 'docker ps';
    const pending = makePending({
      name: 'shell',
      callId: `docker-${scope}`,
      arguments: JSON.stringify({ command, cwd: process.cwd() }),
    });

    const result = createExecutor({ sessionAccess: access }).resolve({ pendingApprovalContext: pending, answer });

    expect(result.isApproved).toBe(true);
    expect(access.hasDockerGrant(command, process.cwd())).toBe(true);
  });

  it('fails closed for generic approval of Docker host control and clears a denied Docker request on rejection', () => {
    const access = makeSessionAccess();
    const command = 'indirect-command';
    access.recordDockerDenial(command);
    const rejections: string[] = [];
    const pending = makePending(
      { name: 'shell', callId: 'docker-deny', arguments: JSON.stringify({ command }) },
      { reject: (_interruption, options) => rejections.push(options?.message ?? '') },
    );

    const result = createExecutor({ sessionAccess: access }).resolve({ pendingApprovalContext: pending, answer: 'y' });

    expect(result.isApproved).toBe(false);
    expect(rejections).toEqual(['Tool execution was not approved.']);
    expect(access.requiresDockerApproval(command)).toBe(false);
    expect(access.hasDockerGrant(command, process.cwd())).toBe(false);
  });

  it('rejects Docker-specific answers for an ordinary shell command without changing grants', () => {
    const access = makeSessionAccess();
    const rejected: string[] = [];
    const pending = makePending(
      { name: 'shell', callId: 'not-docker', arguments: JSON.stringify({ command: 'git status' }) },
      { reject: (_interruption, options) => rejected.push(options?.message ?? '') },
    );

    const result = createExecutor({ sessionAccess: access }).resolve({
      pendingApprovalContext: pending,
      answer: 'docker-allow-session',
    });

    expect(result.isApproved).toBe(false);
    expect(rejected).toEqual(['Tool execution was not approved.']);
    expect(access.hasDockerSessionGrant(process.cwd())).toBe(false);
  });

  it('emits the same resolved hook payload for policy approval without owning staleness validation', async () => {
    const emitted: unknown[] = [];
    const hookLifecycle: HookLifecyclePort = {
      emit: async (event) => {
        emitted.push(event);
      },
      shutdown: async () => undefined,
    };
    const hookEvents: HookEventFactory = {
      create: (type: string, payload: unknown, correlation: unknown) => ({ type, payload, correlation }),
    } as any;
    const pending = makePending({ name: 'shell', callId: 'hook-call', arguments: { command: 'pwd' } });

    const result = createExecutor({ hookLifecycle, hookEvents }).resolve({
      pendingApprovalContext: pending,
      answer: 'y',
      source: 'policy',
    });

    expect(result.isApproved).toBe(true);
    await Promise.resolve();
    expect(emitted).toEqual([
      {
        type: 'approval.resolved',
        payload: { resolution: 'auto_approved', source: 'policy', executionFollowed: true },
        correlation: { toolCallId: 'hook-call' },
      },
    ]);
  });
});
