import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  bindRunCodeRegistry,
  bindRunCodeNestedApprovalOwner,
  createRunCodeToolDefinition,
  RUN_CODE_LIMITS,
  RUN_CODE_PROHIBITED_TOOLS,
  TOOL_NAME_RUN_CODE,
} from './run-code.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import { wrapNeedsApproval } from '../../../lib/tool-invoke.js';
import type { AnyToolDefinition, ToolRegistry } from '../../types.js';
import { NestedApprovalOwner, type NestedApprovalRequest } from '../../../services/approval/nested-approval-owner.js';
import { SessionAccessState } from '../../../services/session/session-access-state.js';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import { createCreateFileToolDefinition } from '../../file/create-file.js';
import { createApplyPatchToolDefinition } from '../../file/apply-patch.js';
import { createReadFileToolDefinition } from '../../file/read-file.js';
import * as shellOutput from '../../../utils/shell/shell-output.js';
import { ExecutionContext } from '../../../services/execution-context.js';

const workspace = process.cwd();
const noopFormatter = (() => []) as unknown as AnyToolDefinition['formatCommandMessage'];

const tool = (overrides: Partial<AnyToolDefinition> & { name: string }): AnyToolDefinition =>
  ({
    description: 'test tool',
    parameters: z.object({ value: z.string() }),
    needsApproval: () => false,
    execute: (params: unknown) => `echo:${(params as { value: string }).value}`,
    formatCommandMessage: noopFormatter,
    ...overrides,
  } as AnyToolDefinition);

const logging = (): ILoggingService =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() } as unknown as ILoggingService);

const makeApprovalRegistry = (registry: ToolRegistry): ToolApprovalPolicyRegistry => {
  const approvalRegistry = new ToolApprovalPolicyRegistry();
  for (const candidate of registry) {
    approvalRegistry.register({
      toolName: candidate.name,
      parameters: candidate.parameters,
      needsApproval: candidate.needsApproval,
    });
  }
  return approvalRegistry;
};

const build = (registry: ToolRegistry, approvalPolicyRegistry = makeApprovalRegistry(registry)) =>
  createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry: () => registry,
    getCwd: () => workspace,
    approvalPolicyRegistry,
  });

const run = async (
  registry: ToolRegistry,
  code: string,
  params: Record<string, unknown> = {},
  approvalPolicyRegistry = makeApprovalRegistry(registry),
) => String(await build(registry, approvalPolicyRegistry).execute({ code, timeout_ms: 60_000, ...params } as never));

describe('run_code', () => {
  it('denies a nested call when the active workspace changes while approval waits', async () => {
    let cwd = '/workspace/one';
    const effects: string[] = [];
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      parameters: z.object({ path: z.string() }),
      needsApproval: () => true,
      execute: (params) => {
        effects.push((params as { path: string }).path);
        return 'effect';
      },
    });
    approvalRegistry.register({
      toolName: 'protected',
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      getCwd: () => cwd,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const result = runCode.execute(
      { code: "return await tools.protected({ path: 'notes.md' });" },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()).not.toBeNull());
    cwd = '/workspace/two';
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'y' });
    await expect(result).resolves.toContain('Tool execution was not approved');
    expect(effects).toEqual([]);
  });

  it('denies a nested call when an approved symlink retargets while approval waits', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'term2-run-code-workspace-'));
    const targetADir = mkdtempSync(join('/tmp', 'term2-run-code-target-a-'));
    const targetBDir = mkdtempSync(join('/tmp', 'term2-run-code-target-b-'));
    const linkPath = join(workspaceDir, 'link');
    const targetA = join(targetADir, 'file.txt');
    const targetB = join(targetBDir, 'file.txt');
    writeFileSync(targetA, 'a');
    writeFileSync(targetB, 'b');
    symlinkSync(targetADir, linkPath);

    try {
      const settings = createMockSettingsService({});
      const access = new SessionAccessState(settings);
      const createFile = createCreateFileToolDefinition({
        loggingService: logging(),
        settingsService: settings,
        executionContext: ExecutionContext.pin(workspaceDir),
        sessionAccess: access,
      });
      const approvalRegistry = new ToolApprovalPolicyRegistry();
      approvalRegistry.register({
        toolName: createFile.name,
        parameters: createFile.parameters,
        needsApproval: createFile.needsApproval as AnyToolDefinition['needsApproval'],
      });
      const owner = new NestedApprovalOwner();
      let tools: ToolRegistry = [createFile];
      const runCode = createRunCodeToolDefinition({
        loggingService: logging(),
        getToolRegistry: () => tools,
        getCwd: () => workspaceDir,
        approvalPolicyRegistry: approvalRegistry,
        sessionAccess: access,
      });
      const grant = vi.spyOn(access, 'allowEditFile');
      tools = [createFile, runCode];
      bindRunCodeRegistry(tools);
      bindRunCodeNestedApprovalOwner(tools, owner);
      const result = runCode.execute(
        { code: "return await tools.create_file({ path: 'link/file.txt', content: 'effect', overwrite: true });" },
        { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
      );
      await vi.waitFor(() => expect(owner.getSnapshot()).not.toBeNull());
      const displayed = owner.getSnapshot()!;
      expect(displayed.approval.outsideWorkspaceEdit).toEqual({ path: targetA, folder: targetADir });
      unlinkSync(linkPath);
      symlinkSync(targetBDir, linkPath);
      await owner.decide(owner.getSnapshot()!.requestId, { answer: 'allow-edit-file-session' });

      await expect(result).resolves.toContain('Tool execution was not approved');
      expect(grant).not.toHaveBeenCalled();
      expect(readFileSync(targetA, 'utf8')).toBe('a');
      expect(readFileSync(targetB, 'utf8')).toBe('b');
      expect(owner.getSnapshot()).toBeNull();
      await expect(owner.decide(displayed.requestId, { answer: 'allow-edit-file-session' })).resolves.toEqual({
        kind: 'stale',
      });
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(targetADir, { recursive: true, force: true });
      rmSync(targetBDir, { recursive: true, force: true });
    }
  });

  it('uses a real session edit grant for a later matching auto-approved call', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'term2-run-code-grant-workspace-'));
    const outsideDir = mkdtempSync(join('/tmp', 'term2-run-code-grant-outside-'));
    const matchingPath = join(outsideDir, 'matching.txt');
    const nonmatchingPath = join(outsideDir, 'nonmatching.txt');
    try {
      const access = new SessionAccessState(createMockSettingsService({}));
      const editGrant = vi.spyOn(access, 'allowEditFile');
      const createFile = createCreateFileToolDefinition({
        loggingService: logging(),
        settingsService: createMockSettingsService({}),
        executionContext: ExecutionContext.pin(workspaceDir),
        sessionAccess: access,
      });
      const approvalRegistry = new ToolApprovalPolicyRegistry();
      approvalRegistry.register({
        toolName: createFile.name,
        parameters: createFile.parameters,
        needsApproval: createFile.needsApproval as AnyToolDefinition['needsApproval'],
      });
      const owner = new NestedApprovalOwner();
      let tools: ToolRegistry = [createFile];
      const runCode = createRunCodeToolDefinition({
        loggingService: logging(),
        getToolRegistry: () => tools,
        getCwd: () => workspaceDir,
        approvalPolicyRegistry: approvalRegistry,
        sessionAccess: access,
      });
      tools = [createFile, runCode];
      bindRunCodeRegistry(tools);
      bindRunCodeNestedApprovalOwner(tools, owner);
      const result = runCode.execute(
        {
          code:
            'await tools.create_file({ path: ' +
            JSON.stringify(matchingPath) +
            ", content: 'matching' }); try { await tools.create_file({ path: " +
            JSON.stringify(nonmatchingPath) +
            ", content: 'nonmatching' }); } catch { return 'nonmatching denied'; }",
        },
        { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
      );
      await vi.waitFor(() =>
        expect(owner.getSnapshot()?.approval.outsideWorkspaceEdit).toMatchObject({ folder: expect.any(String) }),
      );
      const firstRequestId = owner.getSnapshot()!.requestId;
      await owner.decide(firstRequestId, { answer: 'allow-edit-file-session' });
      await vi.waitFor(() => expect(owner.getSnapshot()?.requestId).not.toBe(firstRequestId));
      await owner.decide(owner.getSnapshot()!.requestId, { answer: 'n' });

      await expect(result).resolves.toContain('nonmatching denied');
      expect(editGrant).toHaveBeenCalledTimes(1);
      expect(readFileSync(matchingPath, 'utf8')).toBe('matching');
      expect(existsSync(nonmatchingPath)).toBe(false);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('exposes canonical apply_patch targets to the session grant choice', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'term2-run-code-patch-workspace-'));
    const outsideDir = mkdtempSync(join('/tmp', 'term2-run-code-patch-outside-'));
    const targetPath = join(outsideDir, 'created.txt');
    try {
      const settings = createMockSettingsService({});
      const access = new SessionAccessState(settings);
      const applyPatch = createApplyPatchToolDefinition({
        loggingService: logging(),
        settingsService: settings,
        executionContext: ExecutionContext.pin(workspaceDir),
        sessionAccess: access,
      });
      const approvalRegistry = new ToolApprovalPolicyRegistry();
      approvalRegistry.register({
        toolName: applyPatch.name,
        parameters: applyPatch.parameters,
        needsApproval: applyPatch.needsApproval as AnyToolDefinition['needsApproval'],
      });
      const owner = new NestedApprovalOwner();
      let tools: ToolRegistry = [applyPatch];
      const runCode = createRunCodeToolDefinition({
        loggingService: logging(),
        getToolRegistry: () => tools,
        getCwd: () => workspaceDir,
        approvalPolicyRegistry: approvalRegistry,
        sessionAccess: access,
      });
      tools = [applyPatch, runCode];
      bindRunCodeRegistry(tools);
      bindRunCodeNestedApprovalOwner(tools, owner);
      const code =
        'return await tools.apply_patch({ patch: ' +
        JSON.stringify('*** Begin Patch\n*** Add File: ' + targetPath + '\n+created by patch\n*** End Patch') +
        ' });';
      const result = runCode.execute(
        { code },
        { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
      );

      await vi.waitFor(() =>
        expect(owner.getSnapshot()?.approval.outsideWorkspaceEdit).toMatchObject({ path: targetPath }),
      );
      await owner.decide(owner.getSnapshot()!.requestId, { answer: 'allow-edit-file-session' });

      await expect(result).resolves.toContain('Created');
      expect(readFileSync(targetPath, 'utf8')).toBe('created by patch\n');
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('waits on the real nested owner, approves once, and resumes the same script', async () => {
    const effects: string[] = [];
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: vi.fn(() => {
        effects.push('effect');
        return 'approved';
      }),
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const result = runCode.execute(
      { code: 'return await tools.protected({ value: "x" });' },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'y' });
    await expect(result).resolves.toContain('approved');
    expect(effects).toEqual(['effect']);
  });

  it('makes a denied nested call catchable without replaying earlier effects', async () => {
    const effects: string[] = [];
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const beforeTool = tool({
      name: 'before',
      execute: vi.fn(() => {
        effects.push('before');
        return 'before';
      }),
    });
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: vi.fn(() => {
        effects.push('bad');
        return 'bad';
      }),
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    approvalRegistry.register({
      toolName: beforeTool.name,
      parameters: beforeTool.parameters,
      needsApproval: beforeTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [beforeTool, protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [beforeTool, protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const result = runCode.execute(
      {
        code: 'await tools.before({ value: "x" }); try { await tools.protected({ value: "x" }); } catch (e) { return "caught"; }',
      },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'n', rejectionReason: 'not this time' });
    await expect(result).resolves.toContain('caught');
    expect(effects).toEqual(['before']);
  });

  it('lets a default-lane sibling run while a serial nested approval waits', async () => {
    const effects: string[] = [];
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: () => {
        effects.push('serial');
        return 'serial';
      },
    });
    const fastTool = tool({
      name: 'fast',
      parallelSafe: true,
      execute: () => {
        effects.push('fast');
        return 'fast';
      },
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    approvalRegistry.register({
      toolName: fastTool.name,
      parameters: fastTool.parameters,
      needsApproval: fastTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool, fastTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, fastTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const result = runCode.execute(
      {
        code: 'const serial = tools.protected({ value: "x" }); const fast = await tools.fast({ value: "y" }); return { fast, serial: await serial };',
      },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    await vi.waitFor(() => expect(effects).toEqual(['fast']));
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'y' });
    await expect(result).resolves.toContain('"fast":"fast"');
    expect(effects).toEqual(['fast', 'serial']);
  });

  it('does not consume the work-clock across a nested approval wait longer than timeout_ms', async () => {
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: () => 'ok',
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const pending = runCode.execute(
      { code: 'return await tools.protected({ value: "x" });', timeout_ms: 500 },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'y' });
    await expect(pending).resolves.toContain('Result:');
    await expect(pending).resolves.not.toContain('Script timed out.');
  }, 20_000);

  it('consumes the work-clock while a default-lane sibling runs during a nested wait', async () => {
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: () => 'serial',
    });
    const slowTool = tool({
      name: 'slow',
      parallelSafe: true,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return 'slow';
      },
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    approvalRegistry.register({
      toolName: slowTool.name,
      parameters: slowTool.parameters,
      needsApproval: slowTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool, slowTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, slowTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const pending = runCode.execute(
      {
        code: 'const serial = tools.protected({ value: "x" }); const slow = tools.slow({ value: "y" }); return { slow: await slow, serial: await serial };',
        timeout_ms: 500,
      },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    await expect(pending).resolves.toContain('Script timed out.');
  }, 20_000);

  it('pauses a prompting call after describe, keyed by worker requestId not callId', async () => {
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: () => 'ok',
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const pending = runCode.execute(
      {
        code: 'await tools.describe("protected"); return await tools.protected({ value: "x" });',
        timeout_ms: 500,
      },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'y' });
    await expect(pending).resolves.toContain('Result:');
    await expect(pending).resolves.not.toContain('Script timed out.');
  }, 20_000);

  it('does not grant or dispatch a late approval after the host run aborts the waiter', async () => {
    const effects: string[] = [];
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => true,
      execute: () => {
        effects.push('effect');
        return 'effect';
      },
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const controller = new AbortController();
    const pending = runCode.execute(
      { code: 'return await tools.protected({ value: "x" });', timeout_ms: 60_000 },
      { context: { sessionId: 'session-1' }, signal: controller.signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('protected'));
    const requestId = owner.getSnapshot()!.requestId;
    controller.abort();
    await expect(pending).resolves.toContain('Script was cancelled');
    await expect(owner.decide(requestId, { answer: 'y' })).resolves.toEqual({ kind: 'stale' });
    expect(effects).toEqual([]);
    expect(owner.getSnapshot()).toBeNull();
  }, 20_000);

  it('does not persist an allow-* grant after the host call signal has aborted', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'term2-run-code-d6-workspace-'));
    const outsideDir = mkdtempSync(join('/tmp', 'term2-run-code-d6-outside-'));
    const targetPath = join(outsideDir, 'granted.txt');
    try {
      const access = new SessionAccessState(createMockSettingsService({}));
      const editGrant = vi.spyOn(access, 'allowEditFile');
      const createFile = createCreateFileToolDefinition({
        loggingService: logging(),
        settingsService: createMockSettingsService({}),
        executionContext: ExecutionContext.pin(workspaceDir),
        sessionAccess: access,
      });
      const approvalRegistry = new ToolApprovalPolicyRegistry();
      approvalRegistry.register({
        toolName: createFile.name,
        parameters: createFile.parameters,
        needsApproval: createFile.needsApproval as AnyToolDefinition['needsApproval'],
      });
      // Parent abort aborts callContext.signal and would normally settle the
      // owner waiter first. Isolate the owner's abort listener so decide still
      // reaches the production grant closure — the residual approve-wins window.
      class Owner extends NestedApprovalOwner {
        override request(request: NestedApprovalRequest) {
          return super.request({ ...request, signal: new AbortController().signal });
        }
      }
      const owner = new Owner();
      let tools: ToolRegistry = [createFile];
      const runCode = createRunCodeToolDefinition({
        loggingService: logging(),
        getToolRegistry: () => tools,
        getCwd: () => workspaceDir,
        approvalPolicyRegistry: approvalRegistry,
        sessionAccess: access,
      });
      tools = [createFile, runCode];
      bindRunCodeRegistry(tools);
      bindRunCodeNestedApprovalOwner(tools, owner);
      const controller = new AbortController();
      const pending = runCode.execute(
        {
          code: 'return await tools.create_file({ path: ' + JSON.stringify(targetPath) + ", content: 'x' });",
          timeout_ms: 60_000,
        },
        { context: { sessionId: 'session-1' }, signal: controller.signal },
      );
      await vi.waitFor(() => expect(owner.getSnapshot()?.toolName).toBe('create_file'));
      const requestId = owner.getSnapshot()!.requestId;
      controller.abort();
      await expect(pending).resolves.toContain('Script was cancelled');
      await owner.decide(requestId, { answer: 'allow-edit-file-session' });
      await vi.waitFor(() => expect(owner.getSnapshot()).toBeNull());
      expect(editGrant).not.toHaveBeenCalled();
      expect(existsSync(targetPath)).toBe(false);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }, 20_000);

  it('permits a still-prompt decision after revalidation becomes auto approval', async () => {
    let evaluations = 0;
    const approvalRegistry = new ToolApprovalPolicyRegistry();
    const protectedTool = tool({
      name: 'protected',
      needsApproval: () => evaluations++ === 0,
      execute: () => 'approved',
    });
    approvalRegistry.register({
      toolName: protectedTool.name,
      parameters: protectedTool.parameters,
      needsApproval: protectedTool.needsApproval,
    });
    const owner = new NestedApprovalOwner();
    let tools: ToolRegistry = [protectedTool];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => tools,
      approvalPolicyRegistry: approvalRegistry,
    });
    tools = [protectedTool, runCode];
    bindRunCodeRegistry(tools);
    bindRunCodeNestedApprovalOwner(tools, owner);
    const result = runCode.execute(
      { code: 'return await tools.protected({ value: "x" });' },
      { context: { sessionId: 'session-1' }, signal: new AbortController().signal },
    );
    await vi.waitFor(() => expect(owner.getSnapshot()).not.toBeNull());
    await owner.decide(owner.getSnapshot()!.requestId, { answer: 'y' });
    await expect(result).resolves.toContain('approved');
    expect(evaluations).toBe(2);
  });

  it('returns an explicitly requested debugging trace', async () => {
    expect(await run([], 'console.log("hello from the script");', { include_console: true })).toContain(
      'hello from the script',
    );
  });

  it('returns the script completion value and suppresses console trace on success', async () => {
    const output = await run([], 'console.log("debug trace"); return { answer: "the result" };');

    expect(output).toContain('Result:\n{"answer":"the result"}');
    expect(output).not.toContain('debug trace');
  });

  it('includes console trace on failure so the error remains actionable', async () => {
    const output = await run([], 'console.log("debug trace"); throw new Error("broken");');

    expect(output).toContain('Script failed');
    expect(output).toContain('debug trace');
  });

  it('includes console trace on success only when explicitly requested', async () => {
    const output = await run([], 'console.log("debug trace"); return "the result";', { include_console: true });

    expect(output).toContain('Result:\nthe result');
    expect(output).toContain('debug trace');
  });

  it('clips an opted-in console trace without clipping the completion value away', async () => {
    const output = await run([], `console.log("trace ".repeat(10_000)); return "answer";`, {
      include_console: true,
    });

    expect(output).toContain('Result:\nanswer');
    expect(output).toContain('[truncated: output exceeded');
    expect(output.length).toBeLessThanOrEqual(30_000);
  });

  it('preserves a clipped final result in a readable artifact without repeating tool effects', async () => {
    const execute = vi.fn(() => 'x'.repeat(35_000) + '\nTAIL-EVIDENCE');
    const output = await run([tool({ name: 'effect', execute })], 'return await tools.effect({value:"once"});');
    const artifact = output.match(/Full output saved to `([^`]+)`/)?.[1];
    expect(execute).toHaveBeenCalledTimes(1);
    expect(output.length).toBeLessThanOrEqual(30_000);
    expect(output).not.toContain('TAIL-EVIDENCE');
    expect(artifact).toBeDefined();
    try {
      expect(readFileSync(artifact!, 'utf8')).toContain('TAIL-EVIDENCE');
      expect(readFileSync(artifact!, 'utf8')).toContain('[1 tool call: effect]');
    } finally {
      if (artifact) rmSync(artifact);
    }
  });

  it('keeps successful effects successful when output artifact storage fails', async () => {
    const save = vi.spyOn(shellOutput, 'saveOutputArtifact').mockRejectedValue(new Error('disk full'));
    const execute = vi.fn(() => 'x'.repeat(35_000));
    try {
      const output = await run([tool({ name: 'effect', execute })], 'return await tools.effect({value:"once"});');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(output).toContain('Full output could not be saved');
      expect(output).toContain('Do not repeat completed tool effects');
      expect(output).not.toContain('Script failed');
      expect(output.length).toBeLessThanOrEqual(30_000);
    } finally {
      save.mockRestore();
    }
  });

  it('does not create artifacts for short final output', async () => {
    const save = vi.spyOn(shellOutput, 'saveOutputArtifact');
    try {
      expect(await run([], 'return "small";')).toContain('Result:\nsmall');
      expect(save).not.toHaveBeenCalled();
    } finally {
      save.mockRestore();
    }
  });

  it('keeps the whole bounded-batch result when one independent tool rejects', async () => {
    const code = `const results = await Promise.allSettled([tools.echo({value:"ok"}), tools.broken({value:"bad"})]);
      return results.map((r) => r.status === "fulfilled" ? {value:r.value} : {error:r.reason.message});`;
    const output = await run(
      [
        tool({ name: 'echo', parallelSafe: true }),
        tool({
          name: 'broken',
          parallelSafe: true,
          execute: () => {
            throw new Error('missing file');
          },
        }),
      ],
      code,
    );
    expect(output).toContain('echo:ok');
    expect(output).toContain('missing file');
    expect(output).toContain('2 tool calls');
  });

  it('runs the advertised bounded read example against real file results', async () => {
    const directory = mkdtempSync(join(workspace, '.run-code-example-'));
    try {
      writeFileSync(join(directory, 'a.ts'), 'hello'.repeat(1000));
      const example = build([])
        .description.split('Example: `')[1]!
        .slice(0, -1)
        .replace('"a.ts"', JSON.stringify(join(directory, 'a.ts')))
        .replace('"b.ts"', JSON.stringify(join(directory, 'b.ts')));
      const output = await run([createReadFileToolDefinition() as AnyToolDefinition], example);
      expect(output).toContain('hello');
      expect(output).toContain('File not found');
      expect(output).not.toContain('Script failed');
      expect(output.length).toBeLessThan(3000);
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it('guides bounded batches and direct literal patches before scripting', () => {
    const description = build([]).description;
    expect(description).toContain('Promise.allSettled');
    expect(description).toContain('30,000');
    expect(description).toContain('apply_patch directly');
    expect(description).toContain('template literal');
  });

  it('explains that a successful script with no return value produces no result', async () => {
    const output = await run([], 'console.log("debug trace only");');

    expect(output).toContain('Script returned no result. Return a value from the script');
    expect(output).not.toContain('debug trace only');
  });

  it('preserves null as an explicit completion value', async () => {
    expect(await run([], 'return null;')).toContain('Result:\nnull');
  });

  it('does not let a real describe tool shadow metadata lookup', async () => {
    const execute = vi.fn(() => 'real describe result');
    const toolDefinition = tool({ name: 'describe', execute });

    expect(await run([toolDefinition], 'return await tools.describe({ value: "x" });')).toContain(
      'real describe result',
    );
    expect(await run([toolDefinition], 'return await tools.describe("describe");')).toContain('"name":"describe"');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('calls a real tool and returns its result to the script', async () => {
    const output = await run([tool({ name: 'echo' })], 'return await tools.echo({ value: "round-trip" });');

    expect(output).toContain('echo:round-trip');
    expect(output).toContain('1 tool call: echo');
  });

  it('executes a genuinely auto-approved tool from inside a script', async () => {
    const execute = vi.fn(() => 'auto-approved result');
    const output = await run(
      [tool({ name: 'auto', execute, needsApproval: () => false })],
      'return await tools.auto({ value: "x" });',
    );

    expect(output).toContain('auto-approved result');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('lets a script loop over many tool calls in one execution', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `const out = [];
       for (const value of ["a", "b", "c"]) out.push(await tools.echo({ value }));
       return out.join("|");`,
    );

    expect(output).toContain('echo:a|echo:b|echo:c');
    expect(output).toContain('3 tool calls: echo×3');
  });

  it('never prompts for approval', async () => {
    expect(await build([]).needsApproval({ code: 'x' } as never)).toBe(false);
  });

  it('rejects a call whose parameters fail the real schema, without running the tool', async () => {
    const execute = vi.fn(() => 'must not run');
    const output = await run(
      [tool({ name: 'strict', execute })],
      `try { await tools.strict({ value: 42 }); } catch (error) { console.log("caught:", error.message); }`,
      { include_console: true },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(output).toContain('Invalid parameters for "strict"');
  });

  it('exposes exactly the registry, so an unknown tool name is simply absent', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `console.log("names:", Object.keys(tools).join(","), "missing:", typeof tools.missing);`,
      { include_console: true },
    );

    expect(output).toContain('names: echo,describe missing: undefined');
  });

  it('truncates an oversized tool result with an explicit marker', async () => {
    const output = await run(
      [tool({ name: 'big', execute: () => 'x'.repeat(RUN_CODE_LIMITS.maxResultChars + 100) })],
      `const result = await tools.big({ value: "x" });
       console.log("truncated:", result.includes("[truncated: result exceeded"), result.length < ${
         RUN_CODE_LIMITS.maxResultChars + 100
       });`,
      { include_console: true },
    );

    expect(output).toContain('truncated: true true');
  });

  it('stops the script at its call budget instead of letting it loop forever', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `let calls = 0;
       try {
         for (let i = 0; i < ${RUN_CODE_LIMITS.maxCalls + 5}; i++) { await tools.echo({ value: "x" }); calls++; }
       } catch (error) { console.log("stopped after", calls, error.message); }`,
      { timeout_ms: 30_000, include_console: true },
    );

    expect(output).toContain(`stopped after ${RUN_CODE_LIMITS.maxCalls}`);
    expect(output).toContain('Tool call limit reached');
  }, 30_000);

  it('surfaces a tool that needs approval as a catchable error and names it in the summary', async () => {
    const output = await run(
      [tool({ name: 'locked', needsApproval: () => true })],
      `try { await tools.locked({ value: "x" }); } catch (error) { console.log("caught:", error.message); }`,
      { include_console: true },
    );

    expect(output).toContain('caught:');
    expect(output).toContain('requires approval and is unavailable from inside a script');
    expect(output).toContain(
      'Refused (needs user approval; not directly callable in this model configuration): locked',
    );
  });

  it('denies a tool with no registered approval policy', async () => {
    const execute = vi.fn(() => 'must not run');
    const output = await run(
      [tool({ name: 'unknown-policy', execute })],
      'try { await tools["unknown-policy"]({ value: "x" }); } catch (error) { console.log(error.message); }',
      { include_console: true },
      new ToolApprovalPolicyRegistry(),
    );

    expect(output).toContain('has no registered approval policy and is unavailable from inside a script');
    expect(output).toContain('Unavailable (no registered approval policy');
    expect(output).not.toContain('requires approval');
    expect(execute).not.toHaveBeenCalled();
  });

  it('never exposes run_code to the script, so a run cannot recurse', async () => {
    const registry: AnyToolDefinition[] = [tool({ name: 'echo' })];
    const definition = build(registry);
    registry.push(definition as unknown as AnyToolDefinition);

    const output = String(
      await definition.execute({
        code: `console.log(typeof tools.${TOOL_NAME_RUN_CODE});`,
        timeout_ms: 60_000,
        include_console: true,
      } as never),
    );

    expect(output).toContain('undefined');
  });

  it.each([...RUN_CODE_PROHIBITED_TOOLS])('never exposes the prohibited tool %s', async (name) => {
    const execute = vi.fn(() => 'must not run');
    const output = await run(
      [tool({ name, execute }), tool({ name: 'echo' })],
      `console.log("exposed:", typeof tools[${JSON.stringify(name)}]);
       console.log("names:", Object.keys(tools).join(","));`,
      { include_console: true },
    );

    expect(output).toContain('exposed: undefined');
    expect(output).toContain('names: echo');
    expect(execute).not.toHaveBeenCalled();
  });

  it('omits prohibited tools from the description it advertises', () => {
    const description = build([
      tool({ name: 'run_subagent' }),
      tool({ name: 'shell' }),
      tool({ name: 'echo' }),
    ]).description;

    expect(description).toContain('tools.echo');
    expect(description).not.toContain('run_subagent');
    expect(description).not.toContain('tools.shell(');
    expect(description).toContain('Auto-approved tools run normally');
    expect(description).toContain('requires user approval is unavailable from inside a script');
  });

  it('teaches the model to return a value and describes the console opt-in', () => {
    const description = build([]).description;

    expect(description).toContain('Return the value you want the model to receive');
    expect(description).toContain('`console.log` is a debugging trace');
    expect(description).toContain('include_console');
    expect(description).not.toContain('print results with console.log');
    expect(description).not.toContain('return only inside your own functions');
  });

  it('describes an exposed tool with its full schema and description', async () => {
    const output = await run(
      [
        tool({
          name: 'inspect',
          description: 'Inspect a target.',
          parameters: z.object({ target: z.string(), deep: z.boolean().optional() }),
        }),
      ],
      'return await tools.describe("inspect");',
    );

    expect(output).toContain('"name":"inspect"');
    expect(output).toContain('"description":"Inspect a target."');
    expect(output).toContain('"target"');
    expect(output).toContain('"deep"');
  });

  it('does not charge metadata lookup against the tool-call budget', async () => {
    const output = await run(
      [tool({ name: 'inspect' })],
      `for (let i = 0; i < ${RUN_CODE_LIMITS.maxCalls + 1}; i++) await tools.describe("inspect");
       return await tools.inspect({ value: "ok" });`,
    );

    expect(output).toContain('Result:\necho:ok');
    expect(output).toContain('1 tool call: inspect');
    expect(output).not.toContain('Tool call limit reached');
  });

  it('uses the namespace unknown-tool wording for prohibited and absent descriptions', async () => {
    const output = await run(
      [tool({ name: 'echo' })],
      `for (const name of ["shell", "missing"]) {
        try { await tools.describe(name); } catch (error) { console.log(error.message); }
      }`,
      { include_console: true },
    );

    expect(output).toContain('Unknown tool "shell". Available: echo');
    expect(output).toContain('Unknown tool "missing". Available: echo');
  });

  it('does not advise a non-direct conditional tool to be called directly', async () => {
    const output = await run(
      [tool({ name: 'conditional', needsApproval: ({ value }) => value === 'outside' })],
      `try { await tools.conditional({ value: "outside" }); } catch (error) { return error.message; }`,
    );

    expect(output).toContain('not directly callable in this model configuration');
    expect(output).not.toContain('Call conditional directly as a tool instead');
    expect(output).not.toContain('call these directly instead: conditional');
  });

  it('reports a script that throws', async () => {
    const output = await run([], 'throw new Error("script failed on purpose");');

    expect(output).toContain('Script failed');
    expect(output).toContain('script failed on purpose');
  });

  it('reports a timeout rather than hanging the turn', async () => {
    const output = await run([], 'while (true) {}', { timeout_ms: 1_500 });

    expect(output).toContain('Script timed out.');
  }, 20_000);

  it('rejects a non-positive timeout because setTimeout(fn, 0) fires promptly', () => {
    const schema = build([]).parameters;

    expect(schema.safeParse({ code: 'x', timeout_ms: 0 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: -1 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: 1_000 }).success).toBe(true);
  });

  it('rejects a timeout above 2**31-1, which Node would wrap to ~1ms', () => {
    const schema = build([]).parameters;

    expect(schema.safeParse({ code: 'x', timeout_ms: 2_147_483_646 }).success).toBe(true);
    expect(schema.safeParse({ code: 'x', timeout_ms: 2_147_483_647 }).success).toBe(true);
    expect(schema.safeParse({ code: 'x', timeout_ms: 2_147_483_648 }).success).toBe(false);
    expect(schema.safeParse({ code: 'x', timeout_ms: 3_000_000_000 }).success).toBe(false);
  });

  it('gives the script no filesystem, network, or ambient host globals', async () => {
    const output = await run(
      [],
      `console.log([typeof process, typeof require, typeof Buffer, typeof globalThis.fetch].join(","));`,
      { include_console: true },
    );

    expect(output).toContain('undefined,undefined,undefined,undefined');
  });

  it('stops the script when the caller aborts the turn', async () => {
    const controller = new AbortController();
    const pending = build([]).execute(
      { code: 'while (true) {}', timeout_ms: 60_000 } as never,
      { signal: controller.signal } as never,
    );
    setTimeout(() => controller.abort(), 300);

    const output = String(await pending);

    expect(output).toContain('Script was cancelled.');
    expect(output).toContain('cancelled by its parent');
    expect(output).not.toContain('Script timed out.');
  }, 20_000);

  it('aborts an in-flight nested tool when the script deadline fires', async () => {
    const nestedAborted = vi.fn();
    const definition = build([
      tool({
        name: 'slow',
        execute: async (_params: unknown, context: unknown) => {
          const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              nestedAborted();
              resolve();
              return;
            }
            signal?.addEventListener(
              'abort',
              () => {
                nestedAborted();
                resolve();
              },
              { once: true },
            );
          });
          return 'aborted';
        },
      }),
    ]);

    const output = String(
      await definition.execute({ code: 'await tools.slow({ value: "x" });', timeout_ms: 500 } as never),
    );

    expect(output).toContain('timed out');
    await vi.waitFor(() => expect(nestedAborted).toHaveBeenCalledOnce());
  }, 20_000);

  it('passes caller cancellation to an in-flight nested tool', async () => {
    const nestedAborted = vi.fn();
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const definition = build([
      tool({
        name: 'slow',
        execute: async (_params: unknown, context: unknown) => {
          const signal = (context as { signal?: AbortSignal } | undefined)?.signal;
          started();
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              nestedAborted();
              resolve();
              return;
            }
            signal?.addEventListener(
              'abort',
              () => {
                nestedAborted();
                resolve();
              },
              { once: true },
            );
          });
          return 'aborted';
        },
      }),
    ]);
    const controller = new AbortController();
    const pending = definition.execute(
      { code: 'await tools.slow({ value: "x" });', timeout_ms: 60_000 } as never,
      { signal: controller.signal } as never,
    );
    await inFlight;
    controller.abort();

    const output = String(await pending);

    expect(output).toContain('Script was cancelled.');
    expect(output).toContain('cancelled by its parent');
    await vi.waitFor(() => expect(nestedAborted).toHaveBeenCalledOnce());
  }, 20_000);

  it('forwards the tool invocation context to every tool the script calls', async () => {
    const seen: unknown[] = [];
    const definition = build([
      tool({
        name: 'ctx',
        execute: (_params: unknown, context: unknown) => {
          seen.push(context);
          return 'ok';
        },
      }),
    ]);
    const marker = { signal: undefined, marker: 'caller-context' };

    await definition.execute(
      { code: 'console.log(await tools.ctx({ value: "x" }));', timeout_ms: 60_000 } as never,
      marker as never,
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(expect.objectContaining({ marker: 'caller-context' }));
    expect((seen[0] as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
  });

  it('passes a unique namespaced bridge call ID to each tool execution', async () => {
    const details: unknown[] = [];
    const output = await run(
      [
        tool({
          name: 'ids',
          execute: (_params: unknown, _context: unknown, callDetails: unknown) => {
            details.push(callDetails);
            return 'ok';
          },
        }),
      ],
      `await Promise.all([
        tools.ids({ value: "one" }),
        tools.ids({ value: "two" }),
      ]);`,
    );

    expect(output).toContain('2 tool calls: ids×2');
    const callIds = details.map((value) => (value as { toolCall: { callId: string } }).toolCall.callId);
    expect(new Set(callIds).size).toBe(2);
    expect(callIds.every((callId) => /^run_code_bridge_\d+:\d+$/.test(callId))).toBe(true);
  });

  it('serialises calls to a tool that is not parallel-safe', async () => {
    let active = 0;
    let maxActive = 0;
    const output = await run(
      [
        tool({
          name: 'exclusive',
          execute: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return 'done';
          },
        }),
      ],
      `await Promise.all([1,2,3,4].map((n) => tools.exclusive({ value: String(n) })));
       return "finished";`,
    );

    expect(output).toContain('finished');
    expect(maxActive).toBe(1);
  }, 20_000);

  it('lets a parallel-safe tool overlap so fan-out stays fast', async () => {
    let active = 0;
    let maxActive = 0;
    await run(
      [
        tool({
          name: 'concurrent',
          parallelSafe: true,
          execute: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, 40));
            active -= 1;
            return 'done';
          },
        }),
      ],
      `await Promise.all([1,2,3,4].map((n) => tools.concurrent({ value: String(n) })));
       return "finished";`,
    );

    expect(maxActive).toBeGreaterThan(1);
  }, 20_000);
});

describe('bindRunCodeRegistry', () => {
  it('makes the script call the wrapped definitions, not the raw ones', async () => {
    const raw = tool({
      name: 'guarded',
      execute: () => 'RAW IMPLEMENTATION RAN',
    });
    const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
    const definition = createRunCodeToolDefinition({
      loggingService: logging(),
      getCwd: () => workspace,
      approvalPolicyRegistry,
    });

    // Mirrors agent-factory: the policy layer wraps each definition, then binds
    // the wrapped list into run_code.
    const wrappedNeedsApproval = wrapNeedsApproval(raw, {
      toolName: raw.name,
      registry: approvalPolicyRegistry,
    });
    const wrapped: ToolRegistry = [
      { ...raw, needsApproval: wrappedNeedsApproval, execute: () => 'policy layer refused this call' },
      definition as unknown as AnyToolDefinition,
    ];
    bindRunCodeRegistry(wrapped);

    const output = String(
      await definition.execute({
        code: 'return await tools.guarded({ value: "x" });',
        timeout_ms: 60_000,
      } as never),
    );

    expect(output).toContain('policy layer refused this call');
    expect(output).not.toContain('RAW IMPLEMENTATION RAN');
  });

  it('exposes no tools at all when the registry was never bound', async () => {
    const definition = createRunCodeToolDefinition({
      loggingService: logging(),
      getCwd: () => workspace,
      approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
    });

    const output = String(
      await definition.execute({
        code: 'console.log("tool count:", Object.keys(tools).length, Object.keys(tools).join(","));',
        timeout_ms: 60_000,
        include_console: true,
      } as never),
    );

    expect(output).toContain('tool count: 1');
    expect(output).toContain('describe');
  });
});

describe('run_code nested result cap', () => {
  const capturing = () => {
    const seen: unknown[] = [];
    const definition = tool({
      name: 'reader',
      parameters: z.object({ path: z.string() }),
      execute: (_params: unknown, context: unknown) => {
        seen.push((context as { scripted?: unknown } | undefined)?.scripted);
        return 'contents';
      },
    });
    return { seen, registry: [definition] as ToolRegistry };
  };

  it('marks a call made from inside a script as scripted', async () => {
    const { seen, registry } = capturing();

    await run(registry, `return await tools.reader({ path: 'a.ts' });`);

    // read_file reads this to skip the 40,000-byte context cap: the value goes
    // to the script, not into model context, and a silent partial read makes
    // whatever the script computes from it wrong.
    expect(seen).toEqual([true]);
  });
});

// The nested-call logger ships on main (08a71cf7) but is only ever enabled by
// an env var, so nothing in the normal suite exercises it. It was validated by
// three experiment builds behaving identically, which is not a floor anyone can
// rely on later: M2 of the nested-approval work plans to read acceptance
// evidence off these records. These tests pin the two properties that make it
// safe to ship — inert when unset, and incapable of breaking a script when the
// write fails.
describe('run_code nested-call instrumentation', () => {
  const withSession = (sessionId: string) => ({ context: { sessionId } });
  let dir: string | undefined;

  afterEach(() => {
    delete process.env.TERM2_NESTED_CALL_LOG;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  const runWithContext = async (registry: ToolRegistry, code: string, context: unknown) =>
    String(await build(registry).execute({ code, timeout_ms: 60_000 } as never, context as never));

  it('writes nothing when TERM2_NESTED_CALL_LOG is unset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nested-log-'));
    const logPath = join(dir, 'calls.jsonl');
    delete process.env.TERM2_NESTED_CALL_LOG;

    const output = await runWithContext(
      [tool({ name: 'echo' })],
      'return await tools.echo({ value: "x" });',
      withSession('session-a'),
    );

    expect(output).toContain('echo:x');
    expect(existsSync(logPath)).toBe(false);
  });

  it('writes one record per nested dispatch when enabled', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nested-log-'));
    const logPath = join(dir, 'calls.jsonl');
    process.env.TERM2_NESTED_CALL_LOG = logPath;

    await runWithContext(
      [tool({ name: 'echo' })],
      'for (const value of ["a", "b"]) await tools.echo({ value });',
      withSession('session-b'),
    );

    const records = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.tool).toBe('echo');
      expect(record.sessionId).toBe('session-b');
      expect(record.outcome).toBe('success');
      expect(typeof record.timestamp).toBe('string');
    }
  });

  it('records a denied nested call as denied-by-approval, not as a failure', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nested-log-'));
    const logPath = join(dir, 'calls.jsonl');
    process.env.TERM2_NESTED_CALL_LOG = logPath;

    // A tool that requires approval cannot be resolved from inside a script,
    // because a script cannot prompt. That is a denial, and conflating it with
    // a failure is what hides an unshippable configuration.
    await runWithContext(
      [tool({ name: 'strict', needsApproval: () => true })],
      'try { await tools.strict({ value: "x" }); } catch {}',
      withSession('session-c'),
    );

    const outcomes = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line).outcome);

    expect(outcomes).toContain('denied-by-approval');
    expect(outcomes).not.toContain('failure');
  });

  it('does not disturb script execution when the log path cannot be written', async () => {
    process.env.TERM2_NESTED_CALL_LOG = join(tmpdir(), 'nested-log-missing-dir', 'calls.jsonl');

    const output = await runWithContext(
      [tool({ name: 'echo' })],
      'return await tools.echo({ value: "survives" });',
      withSession('session-d'),
    );

    expect(output).toContain('echo:survives');
  });

  it('writes nothing when the session id is absent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nested-log-'));
    const logPath = join(dir, 'calls.jsonl');
    process.env.TERM2_NESTED_CALL_LOG = logPath;

    await runWithContext([tool({ name: 'echo' })], 'return await tools.echo({ value: "x" });', {});

    expect(existsSync(logPath)).toBe(false);
  });
});
