import { posix } from 'node:path';
import { ExecutionContext } from '../../../source/services/execution-context.js';
import type { ISSHService } from '../../../source/services/service-interfaces.js';
import { quoteShellArg, SSHService } from '../../../source/services/ssh-service.js';
import type { Workspace } from '../tools/index.js';
import { directRemoteTarget, type DirectRemoteConnection } from './remote-config.js';
import { DirectRemoteTools } from './remote-tools.js';

export type DirectRemoteAuthorization = {
  readonly workspace: Workspace;
  /** SSH is not a filesystem sandbox. This is separate from workspace read/write access. */
  readonly allowUnconfinedShell: boolean;
};
export type DirectRemoteWorkspace = {
  readonly workspace: Workspace;
  readonly executionContext: ExecutionContext;
  readonly sshInfo: { readonly host: string; readonly user: string; readonly port: number; readonly remoteDir: string };
  readonly sourcePolicy: {
    readonly readOnly: boolean;
    readonly allowEdit: boolean;
    readonly allowUnsandboxed: boolean;
  };
  readonly environment: string;
  runTool<T>(toolName: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/**
 * Connect the clean SSH transport, resolve a real physical remote directory,
 * then obtain the caller's actual authority before exposing tools. There is no
 * default grant, fabricated remote path, local fallback or cwd/global mutation.
 * Connecting/resolving are preparation, never acceptance of a tool body.
 */
export async function openDirectRemoteWorkspace(options: {
  readonly connection: DirectRemoteConnection;
  readonly authorize: (
    candidate: Workspace,
    constraints: { readonly filesystemIsolation: 'none'; readonly connection: DirectRemoteConnection },
  ) => DirectRemoteAuthorization | Promise<DirectRemoteAuthorization>;
  readonly createService?: (connection: DirectRemoteConnection) => ISSHService | Promise<ISSHService>;
  readonly signal?: AbortSignal;
}): Promise<DirectRemoteWorkspace> {
  options.signal?.throwIfAborted();
  if (typeof options.authorize !== 'function') throw new Error('Explicit SSH workspace authorization is required.');
  const connection = options.connection;
  if (connection.target !== directRemoteTarget(connection.config))
    throw new Error('SSH target does not match its connection parameters.');
  if (connection.access !== 'read' && connection.access !== 'read_write')
    throw new Error('Invalid requested SSH workspace access.');
  const service = options.createService
    ? await options.createService(connection)
    : new SSHService({ ...connection.config });
  if (!service) throw new Error('Direct SSH service is unavailable.');
  try {
    await service.connect();
    options.signal?.throwIfAborted();
    if (!service.isConnected()) throw new Error('SSH service did not establish a connection.');
    const root = await resolveRoot(service, connection.directory, options.signal);
    const candidate: Workspace = Object.freeze({ root, target: connection.target, access: connection.access });
    const grant = await options.authorize(candidate, { filesystemIsolation: 'none', connection });
    const workspace = authorizedWorkspace(candidate, grant);
    options.signal?.throwIfAborted();
    if (!service.isConnected()) throw new Error('SSH service disconnected during workspace assembly.');
    const transport = new DirectRemoteTools({ service, workspace, allowUnconfinedShell: grant.allowUnconfinedShell });
    const executionContext = new RemoteExecutionContext(transport, workspace.root);
    const readOnly = workspace.access === 'read';
    return Object.freeze({
      workspace,
      executionContext,
      sshInfo: Object.freeze({
        host: connection.config.host,
        user: connection.config.username,
        port: connection.config.port,
        remoteDir: root,
      }),
      sourcePolicy: Object.freeze({
        readOnly,
        allowEdit: !readOnly,
        allowUnsandboxed: !readOnly && grant.allowUnconfinedShell,
      }),
      environment: `SSH remote workspace: ${workspace.target}; cwd: ${workspace.root}. Remote OS, shell and home have not been detected. The controller's local filesystem is not this workspace.`,
      runTool: <T>(toolName: string, signal: AbortSignal, operation: () => Promise<T>) =>
        transport.runTool(toolName, signal, operation),
      close: () => transport.disconnect(),
    });
  } catch (error) {
    try {
      await service.disconnect();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'SSH workspace assembly and disconnect failed.');
    }
    throw error;
  }
}

/** Prevent even exitWorkspace from publishing a process-global local-root change. */
class RemoteExecutionContext extends ExecutionContext {
  override enterWorkspace(): never {
    throw new Error('Local workspace leases are unavailable in direct SSH mode.');
  }
  override exitWorkspace(): never {
    throw new Error('Local workspace leases are unavailable in direct SSH mode.');
  }
}

function authorizedWorkspace(candidate: Workspace, grant: DirectRemoteAuthorization): Workspace {
  if (!grant || typeof grant.allowUnconfinedShell !== 'boolean') throw new Error('Explicit SSH authority is required.');
  const selected = grant.workspace;
  if (!selected || selected.target !== candidate.target || selected.root !== candidate.root) {
    throw new Error('SSH workspace authority does not match the connected endpoint and physical root.');
  }
  if (selected.access !== 'read' && selected.access !== 'read_write')
    throw new Error('Invalid authorized SSH workspace access.');
  if (candidate.access === 'read' && selected.access !== 'read')
    throw new Error('SSH workspace authority cannot widen requested read access.');
  return Object.freeze({ ...selected });
}

async function resolveRoot(service: ISSHService, directory?: string, signal?: AbortSignal): Promise<string> {
  // Relative paths resolve against the real remote login directory, never local cwd.
  const requested =
    directory === undefined ? '"$HOME"' : quoteShellArg(directory.startsWith('-') ? `./${directory}` : directory);
  const command = `cd -P ${requested} && printf '%s\\0' "$PWD"`;
  const result = await service.executeCommand(command, { signal });
  if (result.exitCode !== 0 || result.timedOut)
    throw new Error(`Cannot resolve remote workspace: ${result.stderr || `exit ${result.exitCode}`}`);
  const end = result.stdout.indexOf('\0');
  const root = result.stdout.slice(0, end);
  if (end < 1 || end !== result.stdout.length - 1 || !posix.isAbsolute(root) || posix.normalize(root) !== root) {
    throw new Error('SSH server did not return one absolute physical workspace path.');
  }
  return root;
}
