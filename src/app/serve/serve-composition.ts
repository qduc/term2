/**
 * The parts of `term2 serve` that do not depend on which process hosts the sessions.
 * `launch-serve.ts` composes them over an in-process application; the singleton daemon
 * composes them over its own application when a local client takes a serve lease
 * (`daemon/daemon-serve.ts`, `docs/plans/daemon/spec/transport-unix.md` §5).
 */
import { appendFile } from 'node:fs/promises';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { defaultServeStateDir, type ServeBffKey, type ServeTransport } from '../../host/gateway/serve-args.js';
import { createDirectServerHost, createServerAuthentication } from '../../host/server.js';
import type { SqliteReplayLedger } from '../../host/server-auth.js';
import type { DirectServerTransport } from '../../host/server-transport.js';
import type { ServerTransportOptions } from '../../host/server-contracts.js';
import type { GlobalMutationCoordinator } from '../../host/daemon/global-mutations.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import type { DirectLiveSession } from '../../session/session.js';
import type { DirectApplication } from '../application.js';
import type { DirectAuthority } from '../application-workspaces.js';
import { createServePresentation } from './serve-presentation.js';
import type { ServeSessionIndexBundle } from './serve-session-index.js';
import {
  DirectWorkspaceAuthority,
  type bindDirectSessionAccess,
  type DirectGlobalConfiguration,
} from '../host-config.js';

/** An operator error: printed as one line, never a stack. */
export class ServeRefused extends Error {}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same capabilities in both hosts: the web client sees one feature set. */
export const SERVE_CAPABILITIES = {
  sessionBrowser: true,
  rollover: true,
  backgroundShell: true,
  goalsWrite: true,
  approvalReviewTakeover: true,
  taskActions: ['cancel', 'background'] as const,
};

/**
 * The default location holds the old gateway's data, so the direct server takes
 * a sibling leaf. An explicit directory is the operator's, but one that already
 * holds old gateway data is refused before anything in it changes.
 */
export function prepareServeStateDir(requested: string): string {
  const directory =
    requested === defaultServeStateDir() ? path.join(path.dirname(requested), 'gateway-next') : requested;
  if (existsSync(path.join(directory, 'gateway-data'))) {
    throw new ServeRefused(`${directory} holds old gateway data; choose a new --state-dir.`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function readLockOwnerPid(pidPath: string): number | undefined {
  let pid: number;
  try {
    const text = readFileSync(pidPath, 'utf8').trim();
    if (!/^\d+$/.test(text)) return undefined;
    pid = Number(text);
    if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  } catch {
    return undefined;
  }
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM' ? pid : undefined;
  }
}

/**
 * Exclusive server ownership for a state directory. A SQLite write transaction
 * provides cross-platform process-death recovery; the database stays permanent
 * so unlinking it never splits authority across inodes. The daemon takes the same
 * lock, so an in-process serve and a daemon lease never share a state directory.
 */
export function acquireServeStateDirLock(stateDir: string, ownerPid = process.pid): () => void {
  const lockPath = path.join(stateDir, 'serve.lock.sqlite');
  const pidPath = path.join(stateDir, 'serve.lock.pid');
  let database: Database.Database | undefined;
  try {
    database = new Database(lockPath, { timeout: 0 });
    database.exec('BEGIN IMMEDIATE');
  } catch (error) {
    database?.close();
    if ((error as { code?: string }).code === 'SQLITE_BUSY') {
      const holder = readLockOwnerPid(pidPath);
      const detail = holder !== undefined ? ` (pid ${holder})` : '';
      throw new ServeRefused(
        `state directory ${stateDir} is already in use by another term2 serve process${detail}; stop it or pass a different --state-dir.`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(pidPath, `${ownerPid}\n`, { mode: 0o600 });
  } catch {
    // Diagnostic metadata only; the SQLite lock is the authority.
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      unlinkSync(pidPath);
    } catch {
      // Best-effort cleanup before releasing the SQLite lock.
    }
    database!.close();
  };
}

export function readServePublicKeys(bffKeys: readonly ServeBffKey[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const { kid, pemPath } of bffKeys) {
    try {
      keys.set(kid, readFileSync(pemPath, 'utf8'));
    } catch (error) {
      throw new ServeRefused(`cannot read BFF public key "${kid}" at ${pemPath}: ${messageOf(error)}`);
    }
  }
  return keys;
}

export function serveTransportOptions(transport: ServeTransport): ServerTransportOptions {
  if (transport.kind === 'socket') return { socketPath: transport.socketPath };
  for (const [label, file] of [
    ['tls-cert', transport.certPath],
    ['tls-key', transport.keyPath],
  ] as const) {
    try {
      readFileSync(file);
    } catch (error) {
      throw new ServeRefused(`cannot read --${label} at ${file}: ${messageOf(error)}`);
    }
  }
  return {
    host: transport.host,
    port: transport.port,
    tls: { certPath: transport.certPath, keyPath: transport.keyPath, requireClientCert: false },
  };
}

export function serveEndpointLabel(transport: ServeTransport): string {
  return transport.kind === 'socket'
    ? `transport=socket path=${transport.socketPath}`
    : `transport=tls host=${transport.host} port=${transport.port}`;
}

/** Grants and globals live in the serve state directory, and never in a conversation. */
export function createServeGrants(options: {
  readonly stateDir: string;
  readonly allowWrite: boolean;
  readonly localOwnerUserId: string;
}): DirectWorkspaceAuthority {
  const hostRoot = realpathSync(homedir());
  const hostWritable =
    options.allowWrite &&
    (() => {
      try {
        accessSync(hostRoot, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    })();
  return new DirectWorkspaceAuthority({
    allowWrite: options.allowWrite,
    stateDirectory: options.stateDir,
    staticGrants: [
      {
        workspaceId: 'host',
        ownerUserId: options.localOwnerUserId,
        label: 'This machine (~)',
        root: hostRoot,
        access: hostWritable ? 'read_write' : 'read',
        kind: 'host',
      },
    ],
  });
}

export type ServeSessionAccess = ReturnType<typeof bindDirectSessionAccess<DirectLiveSession, DirectLiveSession>>;

/**
 * Only the local owner reaches a session at all, so a bad assertion subject fails
 * closed. Every session records its owner and grant, and that record, not its
 * path, is what admits a read or write. `resolveGrant` must stay synchronous:
 * it hands the owner to `createSession` through the caller's async context.
 */
export function serveSessionAuthority(access: ServeSessionAccess, owner: string): DirectAuthority {
  return {
    async authorize(principal, request) {
      if (principal.userId !== owner) {
        throw new DirectProtocolError('forbidden', 'Only the local owner may use this server.');
      }
      await access.authorize(principal, request);
    },
    resolveGrant: (principal, grant) => access.resolveWorkspace(principal, grant),
    resolveStored: (root, identity) => access.resolveStoredRoot(root, identity),
    // A read grant is a real grant here, enforced by the tools. Stored roots with no grant already threw.
    canRun: () => true,
    createSession: (workspace, model, binding) => access.sessions.create(workspace, model, binding),
  };
}

/** The surface a web-bound session runs with in the daemon; `launch-serve.ts` spells the same values inline for the parity gate. */
export function serveSessionSurface(grants: DirectWorkspaceAuthority | undefined, bindingId: string | undefined) {
  return {
    autoApprove: false,
    interactive: true,
    sessionBrowser: true,
    allowUnsandboxed: grants !== undefined && bindingId !== undefined ? grants.kindOf(bindingId) === 'host' : false,
    shellEscapeApproval: true,
    preserveSandboxedShellApproval: true,
    // By-design: see scripts/surface-parity-exceptions.json (appWiring.mcp).
    mcp: undefined,
  };
}

/** The authenticated HTTP listener over an application's host. Not started. */
export function createServeHttpTransport(options: {
  readonly app: DirectApplication;
  readonly grants: DirectWorkspaceAuthority;
  readonly configuration: DirectGlobalConfiguration;
  readonly sessionIndexBundle: ServeSessionIndexBundle;
  readonly stateDir: string;
  readonly localOwnerUserId: string;
  readonly allowWrite: boolean;
  readonly transport: ServerTransportOptions;
  readonly issuer: string;
  readonly audience: string;
  readonly publicKeys: Map<string, string>;
  readonly replayLedger: SqliteReplayLedger;
  readonly pairing: boolean;
  readonly printOtp: (otp: string, expiresAt: number) => void;
  readonly mutations?: GlobalMutationCoordinator;
  /** The hosting daemon's identity, so HTTP `daemon/status` names the same daemon as the Unix socket. */
  readonly daemon?: { readonly id: string; readonly version: string; readonly startedAt: string };
}): DirectServerTransport {
  const { app, grants, configuration, sessionIndexBundle, stateDir } = options;
  const auditPath = path.join(stateDir, 'server-audit.jsonl');
  return createDirectServerHost(
    {
      host: app.host,
      workspaces: sessionIndexBundle.workspaces,
      sessionIndex: sessionIndexBundle.index,
      models: () => configuration.listModels(),
      skills: (principal, workspaceId) => {
        if (workspaceId && grants.kindOf(workspaceId) === 'ssh') return [];
        const cwd = workspaceId
          ? grants.resolveWorkspace(principal, grants.resolveGrant(principal, workspaceId)).workspace.root
          : homedir();
        return app.skills(cwd).map((skill) => ({
          name: skill.name,
          description: skill.description,
          isProjectLevel: skill.isProjectLevel,
        }));
      },
      configuration,
      ...(options.mutations ? { mutations: options.mutations } : {}),
      ...(options.daemon
        ? {
            daemonId: options.daemon.id,
            daemonVersion: options.daemon.version,
            daemonStartedAt: options.daemon.startedAt,
          }
        : {}),
      presentation: createServePresentation({
        app,
        grants,
        configuration,
        allowWrite: options.allowWrite,
        onSessionCreated: (id) => sessionIndexBundle.index.refresh(id),
      }),
      localOwnerUserId: options.localOwnerUserId,
      audit: (event) => appendFile(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
    },
    {
      transport: options.transport,
      authentication: createServerAuthentication({
        issuer: options.issuer,
        audience: options.audience,
        publicKeys: options.publicKeys,
        replayLedger: options.replayLedger,
        ...(options.pairing
          ? {
              pairing: {
                enabled: true,
                trustFilePath: path.join(stateDir, 'trusted-clients.json'),
                printOtp: options.printOtp,
              },
            }
          : {}),
      }),
    },
  );
}
