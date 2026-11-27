import { posix } from 'node:path';
import type { Principal } from '../host/index.js';
import type { Workspace } from '../tools/index.js';
import { quoteShellArg } from '../tools/ssh-service.js';
import { requirePrincipal } from './host-config-error.js';
import type { DirectWorkspaceAuthority, WorkspaceAccess, WorkspaceAlias } from './host-config-workspace.js';
import { resolveDirectRemoteConnection } from './remote-config.js';
import { openDirectRemoteWorkspace, type DirectRemoteWorkspace } from './remote.js';

export type DirectRemoteProjectContext = {
  readonly environment: string;
  readonly instructions: string;
  readonly instructionsPath: string;
  readonly instructionsFound: boolean;
};

/**
 * Load project instructions from the actual SSH workspace, never from a
 * same-spelled local path. Absence is distinct from transport/read failure.
 * The caller appends instructions only when the selected profile enables that
 * context source; it must not substitute a local SkillsService scan for SSH.
 */
export async function loadDirectRemoteProjectContext(
  remote: DirectRemoteWorkspace,
  signal: AbortSignal,
): Promise<DirectRemoteProjectContext> {
  const instructionsPath = posix.join(remote.workspace.root, 'AGENTS.md');
  const service = remote.executionContext.getSSHService();
  if (!remote.executionContext.isRemote() || !service) throw new Error('Direct remote context has no SSH service.');
  return remote.runTool('read_file', signal, async () => {
    const file = quoteShellArg(instructionsPath);
    const result = await service.executeCommand(
      `if [ ! -e ${file} ] && [ ! -L ${file} ]; then exit 3; fi; cat -- ${file}`,
    );
    if (result.exitCode === 3 && !result.timedOut) {
      return { environment: remote.environment, instructions: '', instructionsPath, instructionsFound: false };
    }
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error(`Cannot read remote project instructions: ${result.stderr || `exit ${result.exitCode}`}`);
    }
    const content = result.stdout.trim();
    return {
      environment: remote.environment,
      instructions: content
        ? `\n\nRemote AGENTS.md contents (${remote.workspace.target}${instructionsPath}):\n${content}`
        : '',
      instructionsPath,
      instructionsFound: true,
    };
  });
}

/** Verify SSH connectivity, resolve the physical remote root, and persist an SSH workspace grant. */
export async function addServeSshWorkspace(
  grants: DirectWorkspaceAuthority,
  principal: Principal,
  input: {
    readonly target: string;
    readonly port?: number;
    readonly directory?: string;
    readonly access: WorkspaceAccess;
  },
): Promise<WorkspaceAlias> {
  requirePrincipal(principal);
  const directory = input.directory?.trim() || undefined;
  const connection = await resolveDirectRemoteConnection({
    target: input.target.trim(),
    ...(input.port !== undefined ? { port: input.port } : {}),
    ...(directory ? { directory } : {}),
    lite: !directory,
    access: input.access,
  });
  const remote = await openDirectRemoteWorkspace({
    connection,
    authorize: (workspace) => ({ workspace, allowUnconfinedShell: workspace.access === 'read_write' }),
  });
  const resolvedRoot = remote.workspace.root;
  await remote.close().catch(() => undefined);
  const dirSuffix = directory ? `:${directory}` : ':~';
  return grants.addSshGrant(principal, {
    ssh: {
      requestedTarget: connection.requestedTarget,
      target: connection.target,
      host: connection.config.host,
      username: connection.config.username,
      port: connection.config.port,
      ...(connection.config.identityFile ? { identityFile: connection.config.identityFile } : {}),
    },
    root: resolvedRoot,
    access: input.access,
    label: `${connection.requestedTarget}${dirSuffix}`,
  });
}

/** Open a per-session SSH workspace and load remote AGENTS.md when a serve session binds to an SSH grant. */
export async function prepareServeSshSurface(
  grants: DirectWorkspaceAuthority,
  context: { readonly workspace: Workspace; readonly binding?: { readonly client: string; readonly id: string } },
) {
  const ssh = context.binding ? grants.sshTargetOf(context.binding.id) : undefined;
  if (!ssh || context.workspace.target === 'local') return {};
  const remote = await openDirectRemoteWorkspace({
    connection: {
      requestedTarget: ssh.requestedTarget,
      target: ssh.target,
      config: {
        host: ssh.host,
        username: ssh.username,
        port: ssh.port,
        agent: process.env.SSH_AUTH_SOCK,
        ...(ssh.identityFile ? { identityFile: ssh.identityFile } : {}),
      },
      directory: context.workspace.root,
      access: context.workspace.access,
    },
    authorize: (workspace) => ({ workspace, allowUnconfinedShell: workspace.access === 'read_write' }),
  });
  try {
    const controller = new AbortController();
    const { instructions } = await loadDirectRemoteProjectContext(remote, controller.signal);
    return {
      surface: {
        remote,
        projectInstructions: instructions,
        allowUnsandboxed: context.workspace.access === 'read_write',
      },
      dispose: () => remote.close(),
    };
  } catch (error) {
    await remote.close().catch(() => undefined);
    throw error;
  }
}
