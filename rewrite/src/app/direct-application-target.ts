/**
 * Where one user's session runs: this directory, or a workspace over SSH. Each
 * mode opens this before the application, because connecting is asynchronous
 * and tool assembly is not.
 */
import fs from 'node:fs';
import type { WorkspaceGrant } from '../host/in-process-direct-types.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import type { DirectBinding } from '../session/facade-types.js';
import type { Workspace } from '../tools/index.js';
import {
  createLocalAuthority,
  localGrant,
  requireLocalCaller,
  type DirectAuthority,
} from './direct-application-workspaces.js';
import { resolveDirectRemoteConnection } from './direct-remote-config.js';
import { loadDirectRemoteProjectContext } from './direct-remote-context.js';
import { openDirectRemoteWorkspace } from './direct-remote.js';
import type { DirectSshRequest } from './direct-launch-types.js';
import type { ToolSurfaceOptions } from './tool-contract.js';

export type DirectSessionTarget = {
  readonly root: string;
  readonly grant: WorkspaceGrant;
  readonly authority: DirectAuthority;
  /** Adds to every session's tool surface. Empty for a local target. */
  readonly surface: Pick<ToolSurfaceOptions, 'remote' | 'projectInstructions'>;
  /**
   * A stored session records only a path, and the same path exists on any host.
   * This immutable binding is what ties it to its SSH endpoint.
   */
  readonly binding?: DirectBinding;
  /** What a restarted process needs to reach the same workspace. */
  readonly restart?: { readonly target: string; readonly directory: string; readonly port: number };
  /** After the application closes: Session work may still be using the connection until then. */
  close(): Promise<void>;
};

function remoteAuthority(workspace: Workspace): DirectAuthority {
  return {
    authorize: (principal) => requireLocalCaller(principal),
    resolveGrant(principal, grant) {
      requireLocalCaller(principal);
      if (grant.workspaceId !== workspace.root || grant.access !== workspace.access) {
        throw new DirectProtocolError('forbidden', 'This workspace is not the connected SSH workspace.');
      }
      return workspace;
    },
    // A live connection is the only SSH grant, and it covers this one endpoint and root.
    resolveStored(root, identity) {
      if (root === workspace.root && identity?.target === workspace.target) return workspace;
      throw new DirectProtocolError('forbidden', 'This session is not on the connected SSH workspace.');
    },
    canRun: ({ root, access }) => root === workspace.root && access === workspace.access,
  };
}

export async function openDirectSessionTarget(
  ssh: DirectSshRequest | undefined,
  lite: boolean,
  signal: AbortSignal,
): Promise<DirectSessionTarget> {
  if (!ssh) {
    const root = fs.realpathSync(process.cwd());
    return {
      root,
      grant: localGrant(root),
      authority: createLocalAuthority((candidate) => candidate === root),
      surface: {},
      close: async () => {},
    };
  }

  const connection = await resolveDirectRemoteConnection({
    target: ssh.target,
    ...(ssh.remoteDir === null ? {} : { directory: ssh.remoteDir }),
    ...(ssh.port === null ? {} : { port: ssh.port }),
    lite,
    access: 'read_write',
  });
  const remote = await openDirectRemoteWorkspace({
    connection,
    signal,
    // Naming the host on the command line is the owner accepting that SSH has no
    // filesystem isolation. Only these two local modes reach this; ACP and serve never do.
    authorize: (workspace) => ({ workspace, allowUnconfinedShell: true }),
  });
  try {
    const { workspace } = remote;
    // The surface keeps these only for a profile that enables project instructions.
    const { instructions } = await loadDirectRemoteProjectContext(remote, signal);
    return {
      root: workspace.root,
      grant: { workspaceId: workspace.root, access: workspace.access },
      authority: remoteAuthority(workspace),
      surface: { remote, projectInstructions: instructions },
      binding: { client: 'ssh', id: workspace.target },
      restart: { target: ssh.target, directory: workspace.root, port: remote.sshInfo.port },
      // The one close. Sessions borrow this, so one draining cannot cut off another.
      close: () => remote.close(),
    };
  } catch (error) {
    try {
      await remote.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'SSH workspace setup and disconnect failed.');
    }
    throw error;
  }
}
