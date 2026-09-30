import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getAgentDefinition } from '../../../agent.js';
import { ExecutionContext } from '../../../services/execution-context.js';
import type { ILoggingService, ISSHService, SSHCommandResult } from '../../../services/service-interfaces.js';
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

function harness(
  workspace: string,
  remote = false,
  model = 'gpt-5',
  settings: Record<string, unknown> = {},
  remoteSsh: Partial<ISSHService> = {},
) {
  const loggingService = Object.fromEntries(
    ['debug', 'info', 'warn', 'error', 'security'].map((name) => [name, vi.fn()]),
  ) as unknown as ILoggingService;
  const settingsService = createMockSettingsService(settings);
  const access = new SessionAccessState(settingsService);
  const grants = [vi.spyOn(access, 'allowEditFile'), vi.spyOn(access, 'allowEditFolder')];
  const ssh = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    executeCommand: vi.fn(),
    ...remoteSsh,
  };
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

function remotePhysicalPaths(
  paths: readonly string[],
): Pick<ISSHService, 'executeCommand'> & Partial<Omit<ISSHService, 'executeCommand'>> {
  const remaining = [...paths];
  return {
    executeCommand: vi.fn(async (command: string) => {
      if (command.includes('realpath -e')) {
        const physicalPath = remaining.shift();
        if (!physicalPath) throw new Error(`Unexpected remote physical path command: ${command}`);
        return { stdout: `${physicalPath}\0`, stderr: '', exitCode: 0, timedOut: false };
      }
      if (command === 'fd --version') return { stdout: 'fd 10.0\n', stderr: '', exitCode: 0, timedOut: false };
      if (command.startsWith('fd ')) {
        return { stdout: '/home/qduc/media_scanner/index.ts\n', stderr: '', exitCode: 0, timedOut: false };
      }
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false };
    }),
  };
}

/**
 * Exercise the exact command sent through SSH, with a GNU-realpath-compatible
 * shim because macOS's bundled realpath does not support the remote contract's
 * -e/-z flags. The shim only supplies the utility boundary; the generated shell
 * loop, its status handling, and its byte output all run for real.
 */
function realpathShim(root: string): string {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, 'realpath');
  writeFileSync(
    shim,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const nul = args.includes('-z');
const target = args.at(-1);
try {
  process.stdout.write(fs.realpathSync.native(target) + (nul ? '\\0' : '\\n'));
} catch {
  process.exitCode = 1;
}
`,
  );
  chmodSync(shim, 0o755);
  return `${bin}:${process.env.PATH ?? ''}`;
}

function executeResolverCommand(command: string, path: string): SSHCommandResult {
  try {
    return {
      stdout: execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, PATH: path } }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    };
  } catch (error) {
    const result = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: typeof result.status === 'number' ? result.status : 1,
      timedOut: false,
    };
  }
}

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
    'denies remote %s when its physical binding cannot be established',
    async (toolName) => {
      const { workspace, outside } = fixture();
      symlinkSync(outside, join(workspace, 'local-only-link'));
      const h = harness(
        workspace,
        true,
        toolName === 'apply_patch' ? 'gpt-5' : 'claude-sonnet-4',
        {},
        {
          executeCommand: vi.fn(async () => ({ stdout: '', stderr: 'not found', exitCode: 1, timedOut: false })),
        },
      );
      const result = await h.run(
        toolName,
        toolName === 'apply_patch'
          ? patch('*** Add File: local-only-link/remote.txt\n+effect')
          : { path: 'local-only-link/remote.txt', content: 'effect' },
      );
      h.expectDenied(result);
      expect(result).toContain('Cannot establish physical path authority');
      expect(h.ssh.writeFile).not.toHaveBeenCalled();
      expect(h.ssh.mkdir).not.toHaveBeenCalled();
      expect(existsSync(join(outside, 'remote.txt'))).toBe(false);
    },
  );

  it('fails closed when the remote realpath utility is unavailable rather than walking to the filesystem root', async () => {
    const { workspace } = fixture();
    const h = harness(
      workspace,
      true,
      'claude-sonnet-4',
      {},
      {
        executeCommand: vi.fn(async (command: string) => executeResolverCommand(command, '/definitely-unavailable')),
      },
    );

    const result = await h.run('create_file', { path: 'created.txt', content: 'effect' });

    h.expectDenied(result);
    expect(result).toContain('Remote canonicalizer is unavailable or unsupported');
  });

  it('fails closed when remote realpath cannot traverse a directory', async () => {
    const { root, workspace } = fixture();
    const locked = join(workspace, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const h = harness(
      workspace,
      true,
      'claude-sonnet-4',
      {},
      {
        executeCommand: vi.fn(async (command: string) => executeResolverCommand(command, realpathShim(root))),
        readFile: vi.fn(async () => {
          throw new Error('ENOENT');
        }),
      },
    );

    try {
      const result = await h.run('create_file', { path: 'locked/created.txt', content: 'effect' });
      h.expectDenied(result);
      expect(result).toContain('Remote canonicalizer could not resolve path');
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('preserves trailing newlines from the actual remote canonicalizer output', async () => {
    const { root } = fixture();
    const workspace = join(root, 'workspace\n');
    mkdirSync(workspace);
    const h = harness(
      workspace,
      true,
      'claude-sonnet-4',
      { 'shell.autoApproveMode': 'always' },
      {
        executeCommand: vi.fn(async (command: string) => executeResolverCommand(command, realpathShim(root))),
        readFile: vi.fn(async () => {
          throw new Error('ENOENT');
        }),
      },
    );

    await expect(h.run('create_file', { path: 'created.txt', content: 'effect' })).resolves.toContain('Created');
    expect(h.ssh.writeFile).toHaveBeenCalledWith(join(realpathSync(workspace), 'created.txt'), 'effect');
  });

  it('rejects a non-absolute remote canonicalizer response before dispatch', async () => {
    const { workspace } = fixture();
    const h = harness(
      workspace,
      true,
      'claude-sonnet-4',
      {},
      {
        executeCommand: vi.fn(async () => ({ stdout: 'relative\0', stderr: '', exitCode: 0, timedOut: false })),
      },
    );

    const result = await h.run('create_file', { path: 'created.txt', content: 'effect' });

    h.expectDenied(result);
    expect(result).toContain('Invalid remote physical path response');
  });

  it('executes remote read and search tools through the production graph in YOLO after physical binding', async () => {
    const workspace = '/home/qduc/media_scanner';
    const ssh = remotePhysicalPaths([workspace, workspace, workspace, workspace]);
    const readFile = vi.fn(async () => 'remote contents\n');
    ssh.readFile = readFile;
    const h = harness(workspace, true, 'claude-sonnet-4', { 'shell.autoApproveMode': 'always' }, ssh);

    await expect(h.run('read_file', { path: workspace })).resolves.toContain('remote contents');
    await expect(h.run('glob', { pattern: '*.ts', path: workspace })).resolves.toContain('index.ts');

    expect(readFile).toHaveBeenCalledWith(workspace);
    expect(h.snapshots).toEqual([]);
    expect(h.ssh.executeCommand).toHaveBeenCalledWith(expect.stringContaining('realpath -e'));
  });

  it('keeps remote mutation behind approval and denies dispatch when remote authority changes while waiting', async () => {
    const workspace = '/remote/workspace';
    const ssh = remotePhysicalPaths([workspace, `${workspace}/created.txt`, workspace, '/remote/outside/created.txt']);
    ssh.readFile = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    const h = harness(workspace, true, 'claude-sonnet-4', {}, ssh);
    const result = await h.run('create_file', { path: 'created.txt', content: 'effect' });

    expect(h.ssh.executeCommand).toHaveBeenCalledTimes(4);
    expect(result).toContain('Tool execution was not approved');
    expect(h.snapshots).toHaveLength(1);
    expect(h.grants[0]).not.toHaveBeenCalled();
    expect(h.ssh.mkdir).not.toHaveBeenCalled();
    expect(h.ssh.writeFile).not.toHaveBeenCalled();
  });

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
      const physicalTarget = join(realpathSync(outside), 'new', 'created.txt');
      expect(shown.approval.outsideWorkspaceEdit).toEqual({
        path: physicalTarget,
        folder: join(realpathSync(outside), 'new'),
      });
      expect(JSON.parse(shown.approval.argumentsText!)).toEqual(shown.preparedArguments);
      expect(h.grants[0]).toHaveBeenCalledExactlyOnceWith(physicalTarget);
      expect(h.access.allowsEdit(physicalTarget, workspace)).toBe(true);
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
