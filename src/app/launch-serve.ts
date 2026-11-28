/**
 * `term2 serve` on the direct host. This owns a separate state directory and its
 * own conversations: it never reads or writes the old gateway's trust, replay or
 * session data. One process writes each log, so no other client shares them.
 * Sandbox isolation stays required (tools never run unsandboxed); approval mode
 * defaults to `off` (ask) and can be configured per session or via safe settings.
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
import { defaultServeStateDir } from '../host/gateway/serve-args.js';
import { createDirectServerHost, createServerAuthentication } from '../host/server.js';
import { SqliteReplayLedger } from '../host/server-auth.js';
import type { DirectHostLifecycleEvent } from '../host/in-process-direct-types.js';
import type { ServerTransportOptions } from '../host/server-contracts.js';
import { DirectProtocolError } from '../protocol/errors.js';
import { createDirectApplication } from './application.js';
import { createServePresentation } from './daemon/serve-presentation.js';
import { createServeSessionIndex } from './daemon/serve-session-index.js';
import type { DirectAuthorityFactory } from './application-workspaces.js';
import {
  bindDirectSessionAccess,
  createDirectProductPorts,
  DirectGlobalConfiguration,
  DirectWorkspaceAuthority,
} from './host-config.js';
import { prepareServeSshSurface } from './remote-context.js';
import type { DirectLaunchRequest } from './launch-types.js';
import { warnIfSandboxUnavailable } from './sandbox-warning.js';
import { launchServeOverDaemon, shouldLaunchServeOverDaemon } from './daemon/leases/launch-serve-daemon.js';

type ServeRequest = Extract<DirectLaunchRequest, { readonly kind: 'serve' }>;

class ServeRefused extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The default location holds the old gateway's data, so the direct server takes
 * a sibling leaf. An explicit directory is the operator's, but one that already
 * holds old gateway data is refused before anything in it changes.
 */
function prepareStateDir(requested: string): string {
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
 * so unlinking it never splits authority across inodes.
 */
function acquireStateDirLock(stateDir: string): () => void {
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
    writeFileSync(pidPath, `${process.pid}\n`, { mode: 0o600 });
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

function publicKeys({ bffKeys }: ServeRequest['args']): Map<string, string> {
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

function transportOf({ transport }: ServeRequest['args']): ServerTransportOptions {
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

/**
 * Only the local owner reaches a session at all, so a bad assertion subject fails
 * closed. Every session records its owner and grant, and that record, not its
 * path, is what admits a read or write. `resolveGrant` must stay synchronous:
 * it hands the owner to `createSession` through the caller's async context.
 */
function serverAuthority(grants: DirectWorkspaceAuthority, directory: string, owner: string): DirectAuthorityFactory {
  return (store) => {
    const access = bindDirectSessionAccess({ authority: grants, sessions: store, directory });
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
  };
}

export async function launchServe({ args, selection }: ServeRequest): Promise<number> {
  if (shouldLaunchServeOverDaemon(args)) return launchServeOverDaemon(args);
  let stateDir: string;
  let keys: Map<string, string>;
  let transportOptions: ServerTransportOptions;
  let releaseLock: () => void;
  try {
    stateDir = prepareStateDir(args.stateDir);
    keys = publicKeys(args);
    if (keys.size === 0 && !args.pairing) {
      throw new ServeRefused('provide at least one --bff-key <kid>=<pem path> or enable --pairing');
    }
    transportOptions = transportOf(args);
    releaseLock = acquireStateDirLock(stateDir);
  } catch (error) {
    if (!(error instanceof ServeRefused)) throw error;
    process.stderr.write(`term2 serve: ${error.message}\n`);
    return 1;
  }
  try {
    await warnIfSandboxUnavailable('serve', (line) => process.stderr.write(`${line}\n`));

    // Grants and globals live here, in this state directory, and never in a conversation.
    const hostRoot = realpathSync(homedir());
    const hostWritable =
      args.allowWrite &&
      (() => {
        try {
          accessSync(hostRoot, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      })();
    const grants = new DirectWorkspaceAuthority({
      allowWrite: args.allowWrite,
      stateDirectory: stateDir,
      staticGrants: [
        {
          workspaceId: 'host',
          ownerUserId: args.localOwnerUserId,
          label: 'This machine (~)',
          root: hostRoot,
          access: hostWritable ? 'read_write' : 'read',
          kind: 'host',
        },
      ],
    });
    const product = createDirectProductPorts();
    const capabilities = {
      sessionBrowser: true,
      rollover: true,
      backgroundShell: true,
      goalsWrite: true,
      approvalReviewTakeover: true,
      taskActions: ['cancel', 'background'] as const,
    };
    const configuration = new DirectGlobalConfiguration(
      product.settings,
      product.credentials,
      product.providers,
      product.oauth,
      product.models,
      args.allowWrite,
      capabilities,
    );
    const directory = path.join(stateDir, 'conversations');
    const ledger = new SqliteReplayLedger(path.join(stateDir, 'replay.sqlite'));
    const lifecycleObserver: { current?: (event: DirectHostLifecycleEvent) => void } = {};
    const app = await createDirectApplication({
      conversationsDir: directory,
      selection,
      // The browser changes global settings through `configuration`; launch-time
      // selection settings are a stale copy and must not seed a new chat's model.
      resolveDefaultModel: () => configuration.currentModelSelection(),
      surface: (_sessionId, ctx) => ({
        autoApprove: false,
        interactive: true,
        sessionBrowser: true,
        allowUnsandboxed: ctx?.binding ? grants.kindOf(ctx.binding.id) === 'host' : false,
        shellEscapeApproval: true,
        preserveSandboxedShellApproval: true,
        // By-design: see scripts/surface-parity-exceptions.json (appWiring.mcp).
        mcp: undefined,
      }),
      prepareSurface: (_sessionId, ctx) => prepareServeSshSurface(grants, ctx),
      // By-design: see scripts/surface-parity-exceptions.json (appWiring.mcpCatalog, appWiring.hooks).
      mcpCatalog: null,
      hooks: null,
      autoDrainBackgroundNotifications: true,
      onSessionLifecycle: (event) => lifecycleObserver.current?.(event),
      async authorizeModel(next, previous) {
        // A same-selection refresh/rollover does not depend on a fresh catalog.
        if (next.provider === previous.provider && next.model === previous.model) return;
        await configuration.assertModel(next.provider, next.model);
      },
      authority: serverAuthority(grants, directory, args.localOwnerUserId),
    });
    const auditPath = path.join(stateDir, 'server-audit.jsonl');
    // Grant edits must release live sessions; a host without this would keep stale authority.
    const closeWorkspaceSessions = app.host.closeWorkspaceSessions?.bind(app.host);
    if (!closeWorkspaceSessions) throw new Error('The direct host cannot close workspace sessions.');
    const sessionIndexBundle = createServeSessionIndex({
      app,
      grants,
      ownerUserId: args.localOwnerUserId,
      closeWorkspaceSessions,
    });
    lifecycleObserver.current = sessionIndexBundle.observeLifecycle;
    await sessionIndexBundle.index.seed();
    const transport = createDirectServerHost(
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
        presentation: createServePresentation({
          app,
          grants,
          configuration,
          allowWrite: args.allowWrite,
          onSessionCreated: (id) => sessionIndexBundle.index.refresh(id),
        }),
        localOwnerUserId: args.localOwnerUserId,
        audit: (event) => appendFile(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
      },
      {
        transport: transportOptions,
        authentication: createServerAuthentication({
          issuer: args.issuer,
          audience: args.audience,
          publicKeys: keys,
          replayLedger: ledger,
          ...(args.pairing
            ? {
                pairing: {
                  enabled: true,
                  trustFilePath: path.join(stateDir, 'trusted-clients.json'),
                  // The OTP is the operator's out-of-band secret, so it never reaches stdout.
                  printOtp: (otp: string) => process.stderr.write(`PAIRING OTP: ${otp}\n`),
                },
              }
            : {}),
        }),
      },
    );

    const stopped = new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    let exitCode = 0;
    try {
      await transport.start();
      const endpoint =
        args.transport.kind === 'socket'
          ? `transport=socket path=${args.transport.socketPath}`
          : `transport=tls host=${args.transport.host} port=${args.transport.port}`;
      process.stderr.write(`GATEWAY_READY pid=${process.pid} ${endpoint} pairing=${args.pairing ? 'on' : 'off'}\n`);
      await stopped;
    } catch (error) {
      process.stderr.write(`term2 serve: server failed to start: ${messageOf(error)}\n`);
      exitCode = 1;
    } finally {
      // Sessions end only after no client can reach them; the ledger goes last, once nothing verifies.
      try {
        sessionIndexBundle.index.dispose();
        await transport.stop();
        await app.close();
      } finally {
        ledger.close();
      }
    }
    return exitCode;
  } finally {
    releaseLock();
  }
}
