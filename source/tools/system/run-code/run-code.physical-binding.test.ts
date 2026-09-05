import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getAgentDefinition } from '../../../agent.js';
import { ExecutionContext } from '../../../services/execution-context.js';
import type { ILoggingService, ISSHService } from '../../../services/service-interfaces.js';
import { createMockSettingsService } from '../../../services/settings/settings-service.mock.js';
import { SessionAccessState } from '../../../services/session/session-access-state.js';
import { NestedApprovalOwner, type NestedApprovalSnapshot } from '../../../services/approval/nested-approval-owner.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import { createApplyPatchToolDefinition } from '../../file/apply-patch.js';
import { createCreateFileToolDefinition } from '../../file/create-file.js';
import type { ToolRegistry } from '../../types.js';
import { bindRunCodeNestedApprovalOwner, bindRunCodeRegistry, createRunCodeToolDefinition } from './run-code.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join('/tmp', 'term2-binding-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(workspace);
  mkdirSync(outside);
  return { root, workspace, outside };
}

function harness(workspace: string, remote = false, model = 'gpt-5') {
  const loggingService = Object.fromEntries(
    ['debug', 'info', 'warn', 'error', 'security'].map((name) => [name, vi.fn()]),
  ) as unknown as ILoggingService;
  const settingsService = createMockSettingsService({});
  const access = new SessionAccessState(settingsService);
  const grants = [vi.spyOn(access, 'allowEditFile'), vi.spyOn(access, 'allowEditFolder')];
  const ssh = { readFile: vi.fn(), writeFile: vi.fn(), mkdir: vi.fn(), executeCommand: vi.fn() };
  const executionContext = remote
    ? new ExecutionContext(ssh as unknown as ISSHService, workspace)
    : ExecutionContext.pin(workspace);
  const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
  const deps = { loggingService, settingsService, sessionAccess: access, executionContext };
  let tools: ToolRegistry;
  if (remote) {
    // A test-only context option would miss whether production construction
    // actually supplies the executor's remote identity to run_code.
    tools = getAgentDefinition({ ...deps, approvalPolicyRegistry }, model).tools;
  } else {
    tools = [createApplyPatchToolDefinition(deps), createCreateFileToolDefinition(deps)];
    tools = [
      ...tools,
      createRunCodeToolDefinition({
        loggingService,
        sessionAccess: access,
        approvalPolicyRegistry,
        getCwd: () => workspace,
      }),
    ];
  }
  for (const tool of tools)
    approvalPolicyRegistry.register({
      toolName: tool.name,
      parameters: tool.parameters,
      needsApproval: tool.needsApproval,
    });
  const dispatches = tools
    .filter((tool) => ['apply_patch', 'create_file'].includes(tool.name))
    .map((tool) => vi.spyOn(tool, 'execute'));
  const owner = new NestedApprovalOwner();
  bindRunCodeRegistry(tools);
  bindRunCodeNestedApprovalOwner(tools, owner);
  const snapshots: NestedApprovalSnapshot[] = [];
  owner.subscribe((snapshot) => {
    if (!snapshot) return;
    snapshots.push(snapshot);
    void owner.decide(snapshot.requestId, { answer: 'allow-edit-file-session' });
  });
  const runCode = tools.find((tool) => tool.name === 'run_code')!;
  const run = (toolName: string, params: unknown) => {
    expect(tools.some((tool) => tool.name === toolName)).toBe(true);
    return runCode.execute(
      {
        code: `try { return await tools.${toolName}(${JSON.stringify(
          params,
        )}); } catch (error) { return error.message; }`,
      },
      { context: { sessionId: 'binding-session' }, signal: new AbortController().signal },
    );
  };
  const expectDenied = (result: unknown) => {
    expect(result).toContain('physical');
    expect(snapshots).toEqual([]);
    for (const grant of grants) expect(grant).not.toHaveBeenCalled();
    for (const dispatch of dispatches) expect(dispatch).not.toHaveBeenCalled();
    expect(owner.getSnapshot()).toBeNull();
  };
  return { run, access, grants, dispatches, owner, snapshots, ssh, expectDenied };
}

const patch = (body: string) => ({ patch: `*** Begin Patch\n${body}\n*** End Patch` });

describe('run_code physical authority boundary', () => {
  it.each(['apply_patch', 'create_file'])(
    'denies an unresolved dangling leaf before %s grants or effects',
    async (toolName) => {
      const { workspace, outside } = fixture();
      const referent = join(outside, 'missing.txt');
      const alias = join(workspace, 'alias.txt');
      symlinkSync(referent, alias);
      const h = harness(workspace);
      const result = await h.run(
        toolName,
        toolName === 'apply_patch'
          ? patch('*** Add File: alias.txt\n+effect')
          : { path: 'alias.txt', content: 'effect' },
      );
      expect(existsSync(referent)).toBe(false);
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      h.expectDenied(result);
    },
  );

  it.each(['delete', 'move'])('rejects a symlink-leaf %s rather than unlinking its referent', async (operation) => {
    const { workspace, outside } = fixture();
    const referent = join(outside, 'original.txt');
    const alias = join(workspace, 'alias.txt');
    writeFileSync(referent, 'original bytes\n');
    symlinkSync(referent, alias);
    const h = harness(workspace);
    const result = await h.run(
      'apply_patch',
      patch(
        operation === 'delete' ? '*** Delete File: alias.txt' : '*** Update File: alias.txt\n*** Move to: moved.txt',
      ),
    );
    expect(existsSync(referent)).toBe(true);
    expect(readFileSync(referent, 'utf8')).toBe('original bytes\n');
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(existsSync(join(workspace, 'moved.txt'))).toBe(false);
    h.expectDenied(result);
  });

  it.each(['apply_patch', 'create_file'])(
    'denies remote %s through production graph construction',
    async (toolName) => {
      const { workspace, outside } = fixture();
      symlinkSync(outside, join(workspace, 'local-only-link'));
      const h = harness(workspace, true, toolName === 'apply_patch' ? 'gpt-5' : 'claude-sonnet-4');
      const result = await h.run(
        toolName,
        toolName === 'apply_patch'
          ? patch('*** Add File: local-only-link/remote.txt\n+effect')
          : { path: 'local-only-link/remote.txt', content: 'effect' },
      );
      h.expectDenied(result);
      expect(h.ssh.writeFile).not.toHaveBeenCalled();
      expect(h.ssh.mkdir).not.toHaveBeenCalled();
      expect(existsSync(join(outside, 'remote.txt'))).toBe(false);
    },
  );

  it('denies an unresolved physical workspace root even when the absolute target resolves', async () => {
    const { root, outside } = fixture();
    const workspace = join(root, 'dangling-root');
    symlinkSync(join(root, 'missing-root'), workspace);
    const target = join(outside, 'created.txt');
    const h = harness(workspace);
    const result = await h.run('apply_patch', patch(`*** Add File: ${target}\n+effect`));
    expect(existsSync(target)).toBe(false);
    h.expectDenied(result);
  });

  it.each(['apply_patch', 'create_file'])(
    'binds a normal missing leaf for %s to its resolvable ancestor',
    async (toolName) => {
      const { workspace, outside } = fixture();
      symlinkSync(outside, join(workspace, 'link'));
      const target = join(outside, 'new', 'created.txt');
      const h = harness(workspace);
      const result = await h.run(
        toolName,
        toolName === 'apply_patch'
          ? patch('*** Add File: link/new/created.txt\n+effect')
          : { path: 'link/new/created.txt', content: 'effect' },
      );
      expect(result).toContain('Created');
      expect(h.snapshots).toHaveLength(1);
      const shown = h.snapshots[0];
      expect(shown.approval.outsideWorkspaceEdit).toEqual({ path: target, folder: join(outside, 'new') });
      expect(JSON.parse(shown.approval.argumentsText!)).toEqual(shown.preparedArguments);
      expect(h.grants[0]).toHaveBeenCalledExactlyOnceWith(target);
      expect(h.access.allowsEdit(target, workspace)).toBe(true);
      expect(h.access.allowsEdit(join(outside, 'unmentioned.txt'), workspace)).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe(toolName === 'apply_patch' ? 'effect\n' : 'effect');
      const dispatch = h.dispatches.find((spy) => spy.mock.calls.length)!;
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0][0]).toEqual(shown.preparedArguments);
      expect(h.owner.getSnapshot()).toBeNull();
      await expect(h.owner.decide(shown.requestId, { answer: 'allow-edit-file-session' })).resolves.toEqual({
        kind: 'stale',
      });
      expect(h.grants[0]).toHaveBeenCalledTimes(1);
    },
  );
});
