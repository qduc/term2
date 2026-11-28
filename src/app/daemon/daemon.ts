/**
 * Singleton local Term2 daemon (`docs/plans/daemon/README.md`, `zoom/host-and-runtime.md`).
 *
 * Startup order (`transport-unix.md` §1.2):
 * 1. Create and verify 0700 ownership of `runtimeDir` and `dirname(socketPath)`.
 * 2. Acquire exclusive `daemon.lock.sqlite` (`BEGIN IMMEDIATE`); on `SQLITE_BUSY`,
 *    probe `socketPath` and exit cleanly if a peer daemon is already live.
 * 3. While holding the lock, probe & clean any stale socket at `socketPath`.
 * 4. Compose ONE Settings/GlobalConfiguration, ONE GlobalMutationCoordinator,
 *    ONE DirectApplication (`autoDrainBackgroundNotifications: true`), ONE SessionIndex,
 *    ONE DaemonRpc, and ONE DaemonUnixServer; bind socket with `umask(0o077)` + `0600`.
 * 5. Atomically write advisory `0600` `daemon.json`.
 * 6. On shutdown: drain/close, remove `daemon.json` and unlink `daemon.sock` BEFORE releasing lock.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { installationVersion } from '../../model/providers/fetch/logging-middleware.js';
import {
  CLIENT_API_CAPABILITIES,
  type DaemonShutdownParams,
  type DaemonStatusResult,
  type SessionApprovalPolicy,
} from '../../protocol/client-api/client-api-schema.js';
import { CLIENT_API_VERSION } from '../../protocol/client-api/version-negotiation.js';
import { DirectProtocolError } from '../../protocol/errors.js';
import type { DirectHostLifecycleEvent, Principal } from '../../host/in-process-direct-types.js';
import { createSessionIndex } from '../../host/daemon/session-index.js';
import { GlobalMutationCoordinator } from '../../host/daemon/global-mutations.js';
import { ClientApiRpcError, DaemonRpc } from '../../host/daemon/daemon-rpc.js';
import { DaemonUnixServer } from '../../host/daemon/daemon-unix.js';
import { createDirectApplication } from '../application.js';
import { LOCAL_PRINCIPAL, localGrant, requireLocalCaller } from '../application-workspaces.js';
import { createDirectProductPorts, DirectGlobalConfiguration } from '../host-config.js';
import { scanDirectoryEntries } from '../file-service.js';
import { SessionContextService } from '../../model/traffic-context.js';
import { buildEnvOverrides } from '../../config/settings/settings-env.js';
import { createDaemonMcp } from './daemon-mcp.js';
import { applyDaemonSetGoal, prepareDaemonSkillText, readDaemonSessionQuota } from './daemon-session-ops.js';
import { createDaemonV11Port } from './daemon-v11-ops.js';
import { DaemonServeLeaseManager } from './leases/serve-lease.js';
import {
  acquireDaemonLock,
  checkConversationsDirectory,
  DaemonLockBusyError,
  ensureSecurePrivateDir,
  prepareSocketForBind,
  probeSocketConnectable,
  readCurrentProcStartTime,
  removeFileIfPresent,
  resolveDaemonPaths,
  writeDaemonAdvertisement,
  type DaemonPaths,
} from './daemon-paths.js';

const LOCK_CONTENTION_TIMEOUT_MS = 3_000;
const DEFAULT_GRACEFUL_SHUTDOWN_MS = 10_000;

export type StartTerm2DaemonOptions = {
  readonly stateDir?: string;
  readonly conversationsDir?: string;
  readonly socketPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly onShutdownRequested?: () => void;
};

export type Term2DaemonHandle =
  | { readonly kind: 'already_running'; readonly paths: DaemonPaths }
  | {
      readonly kind: 'started';
      readonly daemonId: string;
      readonly paths: DaemonPaths;
      readonly status: () => DaemonStatusResult;
      readonly shutdown: (params?: Partial<DaemonShutdownParams>) => Promise<void>;
      readonly closed: Promise<void>;
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function localWorkspaceIdForRoot(root: string): string {
  return `local_${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
}

async function acquireLockOrDetectPeer(
  lockPath: string,
  socketPath: string,
): Promise<{ readonly kind: 'acquired'; readonly release: () => void } | { readonly kind: 'already_running' }> {
  const deadline = Date.now() + LOCK_CONTENTION_TIMEOUT_MS;
  let attempt = 0;
  for (;;) {
    try {
      return { kind: 'acquired', release: acquireDaemonLock(lockPath) };
    } catch (error) {
      if (!(error instanceof DaemonLockBusyError)) throw error;
      if (await probeSocketConnectable(socketPath, 250)) {
        return { kind: 'already_running' };
      }
      if (Date.now() >= deadline) {
        if (await probeSocketConnectable(socketPath, 500)) {
          return { kind: 'already_running' };
        }
        throw new Error(
          `Daemon lock ${lockPath} remained busy for ${LOCK_CONTENTION_TIMEOUT_MS}ms without a live socket.`,
        );
      }
      const backoff = Math.min(200, 25 * Math.pow(2, attempt));
      attempt += 1;
      await sleep(backoff);
    }
  }
}

export async function startTerm2Daemon(options: StartTerm2DaemonOptions = {}): Promise<Term2DaemonHandle> {
  const paths = resolveDaemonPaths({
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    ...(options.conversationsDir ? { conversationsDir: options.conversationsDir } : {}),
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.env ? { env: options.env } : {}),
  });

  // Step 1: Verify private 0700 runtime & socket directories via lstat.
  ensureSecurePrivateDir(paths.stateDir);
  ensureSecurePrivateDir(paths.runtimeDir);
  ensureSecurePrivateDir(path.dirname(paths.socketPath));
  await checkConversationsDirectory(paths.conversationsDir);

  // Step 2: Acquire exclusive SQLite singleton lock (or yield cleanly to live peer).
  const lockResult = await acquireLockOrDetectPeer(paths.lockPath, paths.socketPath);
  if (lockResult.kind === 'already_running') {
    return { kind: 'already_running', paths };
  }

  const releaseLock = lockResult.release;
  const daemonId = `dmn_${randomUUID().replace(/-/g, '')}`;
  const daemonVersion = installationVersion;
  const startedAt = new Date().toISOString();
  let socketBound = false;
  let advertisementWritten = false;
  let app: Awaited<ReturnType<typeof createDirectApplication>> | null = null;
  let daemonMcp: ReturnType<typeof createDaemonMcp> | null = null;
  let serveLeases: DaemonServeLeaseManager | null = null;
  let unixServer: DaemonUnixServer | null = null;

  try {
    // Step 3: While holding lock, verify & clean any stale socket.
    await prepareSocketForBind(paths.socketPath);

    // Step 4: Compose ONE product/settings/app/index/RPC/UnixServer graph.
    const effectiveEnv = options.env ?? process.env;
    const settingsDir = effectiveEnv['TERM2_SETTINGS_DIR']?.trim() || undefined;
    const sessionContext = new SessionContextService();
    const product = createDirectProductPorts({
      ...(settingsDir ? { settingsDir } : {}),
      env: buildEnvOverrides(),
      loggingServiceOptions: { sessionContextService: sessionContext },
    });
    const settings = product.service;
    const selection = { settings, logger: settings.getLoggingService(), sessionContext };
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
      true,
      capabilities,
    );
    const mutations = new GlobalMutationCoordinator();
    const activeServeLeases = new DaemonServeLeaseManager({
      daemonId,
      conversationsDir: paths.conversationsDir,
      product,
      capabilities,
      mutations,
      localWorkspaceIdForRoot,
    });
    serveLeases = activeServeLeases;
    const sessionPolicies = new Map<string, SessionApprovalPolicy>();
    const sessionLaunchFlags = new Map<
      string,
      { readonly requireSandbox?: boolean; readonly clientMode?: 'interactive' | 'headless' | 'acp' }
    >();
    let pendingCreatePolicy: SessionApprovalPolicy | undefined;
    let pendingLaunchFlags:
      | { readonly requireSandbox?: boolean; readonly clientMode?: 'interactive' | 'headless' | 'acp' }
      | undefined;
    const policyForSession = (sessionId: string): SessionApprovalPolicy | undefined => {
      if (pendingCreatePolicy !== undefined && !sessionPolicies.has(sessionId)) {
        sessionPolicies.set(sessionId, pendingCreatePolicy);
      }
      if (pendingLaunchFlags !== undefined && !sessionLaunchFlags.has(sessionId)) {
        sessionLaunchFlags.set(sessionId, pendingLaunchFlags);
      }
      return sessionPolicies.get(sessionId);
    };
    const lifecycleObserver: { current?: (event: DirectHostLifecycleEvent) => void } = {};
    daemonMcp = createDaemonMcp({
      conversationsDir: paths.conversationsDir,
      settingsDir,
      onWarning: (message) => selection.logger.warn(message),
    });
    const activeDaemonMcp = daemonMcp;

    app = await createDirectApplication({
      conversationsDir: paths.conversationsDir,
      selection,
      resolveDefaultModel: () => configuration.currentModelSelection(),
      authorizeModel: (next, previous) => activeServeLeases.authorizeModel(next, previous),
      prepareSurface: (sessionId, ctx) =>
        activeServeLeases.prepareServeSurface(ctx) ??
        activeDaemonMcp.prepare(sessionId, ctx.workspace, policyForSession(sessionId)?.mode !== 'headless'),
      surface: (sessionId, ctx) => {
        const serveSurface = activeServeLeases.serveSurfaceOptions(ctx);
        if (serveSurface) return serveSurface;
        const policy = policyForSession(sessionId);
        const flags = sessionLaunchFlags.get(sessionId);
        const isHeadless = policy?.mode === 'headless' || flags?.clientMode === 'headless';
        const isAcp = flags?.clientMode === 'acp';
        return {
          autoApprove: policy?.mode === 'headless' ? policy.autoApprove : false,
          interactive: !isHeadless,
          sessionBrowser: !isHeadless && !isAcp,
          allowUnsandboxed: !flags?.requireSandbox && !isAcp,
          shellEscapeApproval: !isAcp,
          preserveSandboxedShellApproval: true,
          mcp: undefined,
        };
      },
      mcpCatalog: null,
      hooks: null,
      autoDrainBackgroundNotifications: true,
      onSessionLifecycle: (event) => {
        if (event.kind === 'closed') {
          sessionPolicies.delete(event.sessionId);
          sessionLaunchFlags.delete(event.sessionId);
        }
        activeServeLeases.observeLifecycle(event);
        lifecycleObserver.current?.(event);
      },
      authority: activeServeLeases.createUnifiedAuthority(),
    });

    const localOwnerApp = app;
    const knownWorkspaceRoots = new Map<string, string>();
    const recordLocalWorkspace = (root: string) => knownWorkspaceRoots.set(localWorkspaceIdForRoot(root), root);
    const resolveWorkspaceRoot = (workspaceId: string): string => {
      const root = knownWorkspaceRoots.get(workspaceId);
      try {
        if (root && fs.realpathSync(root) === root && fs.statSync(root).isDirectory()) return root;
      } catch {
        // A stored workspace can disappear between daemon startup and admission.
      }
      throw new DirectProtocolError('not_found', 'Unknown local workspace.');
    };
    const sessionIndex = createSessionIndex({
      async listStored() {
        const page = await localOwnerApp.listStoredSessions();
        for (const { id, workspace } of page.sessions) {
          if (workspace.target === 'local') {
            recordLocalWorkspace(workspace.root);
            activeServeLeases.recordSessionRoot(id, workspace.root);
          }
        }
        return page;
      },
      resolveBinding: (sessionId) => activeServeLeases.resolveBinding(sessionId),
      resolveVisibility: (principal, record) => activeServeLeases.resolveVisibility(principal, record),
    });
    activeServeLeases.bindRuntime(localOwnerApp, sessionIndex);
    lifecycleObserver.current = (event) => sessionIndex.observeLifecycle(event);
    await sessionIndex.seed();
    const discoveryRoot = async (
      principal: Principal,
      { workspaceId, sessionId }: { workspaceId?: string; sessionId?: string },
    ): Promise<string> => {
      requireLocalCaller(principal);
      if (workspaceId) return resolveWorkspaceRoot(workspaceId);
      if (!sessionId) return process.cwd();
      const session = await sessionIndex.get(principal, sessionId);
      if (!session) throw new DirectProtocolError('not_found', 'Unknown local session workspace.');
      return resolveWorkspaceRoot(session.workspaceId);
    };

    const getCounts = () => sessionIndex.counts();

    const status = (): DaemonStatusResult => {
      const counts = getCounts();
      return {
        daemonId,
        daemonVersion,
        protocolVersion: CLIENT_API_VERSION,
        pid: process.pid,
        startedAt,
        activeSessionCount: counts.activeSessionCount,
        activeTurnCount: counts.activeTurnCount,
        activeBackgroundTaskCount: counts.activeBackgroundTaskCount,
        attachedClientCount: unixServer?.attachedClientCount() ?? 0,
      };
    };

    let shutdownPromise: Promise<void> | null = null;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const rpcHolder: { current?: DaemonRpc } = {};
    const performShutdown = (params: Partial<DaemonShutdownParams> = {}): Promise<void> => {
      if (shutdownPromise) return shutdownPromise;
      const mode = params.mode ?? 'graceful';
      const timeoutMs = params.timeoutMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS;
      rpcHolder.current?.markShuttingDown();
      shutdownPromise = (async () => {
        try {
          if (mode === 'graceful') {
            unixServer?.broadcastDraining({ reason: 'shutdown', gracePeriodMs: timeoutMs });
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              const counts = getCounts();
              if (counts.activeTurnCount === 0 && counts.activeBackgroundTaskCount === 0) break;
              await sleep(50);
            }
          }
        } finally {
          try {
            await unixServer?.close();
          } finally {
            try {
              await serveLeases?.closeAll();
              sessionIndex.dispose();
              await app?.close();
              await daemonMcp?.close();
            } finally {
              // Step 6: remove daemon.json and unlink daemon.sock BEFORE releasing daemon.lock.sqlite.
              if (advertisementWritten) {
                removeFileIfPresent(paths.advertisementPath);
                advertisementWritten = false;
              }
              if (socketBound) {
                removeFileIfPresent(paths.socketPath);
                socketBound = false;
              }
              releaseLock();
              resolveClosed();
              options.onShutdownRequested?.();
            }
          }
        }
      })();
      return shutdownPromise;
    };

    const v11Port = {
      ...createDaemonV11Port({
        app: localOwnerApp,
        sessionIndex,
        mutations,
        configuration,
        productSettings: product.service,
        localWorkspaceIdForRoot,
        recordLocalWorkspace,
        resolveWorkspaceRoot,
        setPendingCreatePolicy: (policy) => {
          pendingCreatePolicy = policy;
        },
        setPendingLaunchFlags: (flags) => {
          pendingLaunchFlags = flags;
        },
      }),
      serveStart: activeServeLeases.startLease.bind(activeServeLeases),
      serveStop: activeServeLeases.stopLease.bind(activeServeLeases),
    };
    const advertisedCapabilities = [...CLIENT_API_CAPABILITIES];
    const rpc = new DaemonRpc({
      host: localOwnerApp.host,
      sessionIndex,
      mutations,
      configuration,
      models: () => configuration.listModels(),
      skills: async (principal, scope) => {
        const root = await discoveryRoot(principal, scope);
        return localOwnerApp.skills(root).map(({ name, description, isProjectLevel }) => ({
          name,
          description,
          isProjectLevel,
        }));
      },
      v11: v11Port,
      control: {
        daemonId,
        daemonVersion,
        startedAt,
        pid: process.pid,
        capabilities: advertisedCapabilities,
        status,
        async shutdown(params) {
          if (params.whenIdle === true) {
            const counts = getCounts();
            if (counts.activeTurnCount > 0 || counts.activeBackgroundTaskCount > 0) {
              throw new ClientApiRpcError('busy', 'Daemon has active turns or background tasks.', {
                retryable: true,
                details: {
                  activeTurnCount: counts.activeTurnCount,
                  activeBackgroundTaskCount: counts.activeBackgroundTaskCount,
                },
              });
            }
          }
          rpcHolder.current?.markShuttingDown();
          // Defer teardown one tick so the RPC response flushes cleanly to the caller first.
          setImmediate(() => void performShutdown(params));
        },
        async resolveCwdGrant(principal, cwd) {
          const resolved = v11Port.canonicalizeCwd!(principal, cwd);
          recordLocalWorkspace(resolved);
          return localGrant(resolved);
        },
        async resolveWorkspaceGrant(principal, workspaceId) {
          requireLocalCaller(principal);
          return localGrant(resolveWorkspaceRoot(workspaceId));
        },
        setPendingCreatePolicy(policy) {
          pendingCreatePolicy = policy;
        },
        forkSession: (_principal, sourceSessionId) => localOwnerApp.forkSession(sourceSessionId),
        handoffSession: (_principal, sourceSessionId, input) =>
          localOwnerApp.handoff(sourceSessionId, undefined, input.text ?? ''),
        setGoal: (principal, sessionId, command) => applyDaemonSetGoal(localOwnerApp, principal, sessionId, command),
        async prepareSkillText(principal, sessionId, skillName, text) {
          const root = await discoveryRoot(principal, { sessionId });
          return prepareDaemonSkillText(localOwnerApp, root, skillName, text);
        },
        quota: (principal, sessionId) => readDaemonSessionQuota(localOwnerApp, principal, sessionId),
        async mcpStatus(principal, scope) {
          requireLocalCaller(principal);
          const root =
            scope.workspaceId || scope.sessionId
              ? await discoveryRoot(principal, scope)
              : activeDaemonMcp.singleActiveRoot();
          return await activeDaemonMcp.status(root);
        },
        async mcpLogin(principal, { serverId, workspaceId }) {
          requireLocalCaller(principal);
          const root = workspaceId ? resolveWorkspaceRoot(workspaceId) : activeDaemonMcp.singleActiveRoot();
          return await activeDaemonMcp.login(root, serverId);
        },
        async files(principal, scope) {
          const root = await discoveryRoot(principal, scope);
          const scanned = await scanDirectoryEntries(root, { maxDepth: 12, maxTotalEntries: 2_000 });
          return { entries: scanned.entries, truncated: scanned.truncated };
        },
      },
    });
    rpcHolder.current = rpc;

    unixServer = new DaemonUnixServer({
      rpc,
      localOwnerPrincipal: LOCAL_PRINCIPAL,
      daemonId,
      daemonVersion,
      pid: process.pid,
      capabilities: advertisedCapabilities,
      activeTurnCount: () => getCounts().activeTurnCount,
    });
    await unixServer.listen(paths.socketPath);
    socketBound = true;

    // Step 5: Atomically write advisory 0600 daemon.json.
    writeDaemonAdvertisement(paths.advertisementPath, {
      daemonId,
      pid: process.pid,
      procStartTime: readCurrentProcStartTime(),
      startedAt,
      socketPath: paths.socketPath,
      daemonVersion,
      protocolVersion: CLIENT_API_VERSION,
    });
    advertisementWritten = true;
    return { kind: 'started', daemonId, paths, status, shutdown: performShutdown, closed };
  } catch (error) {
    await Promise.allSettled([unixServer?.close(), serveLeases?.closeAll(), app?.close(), daemonMcp?.close()]);
    if (advertisementWritten) removeFileIfPresent(paths.advertisementPath);
    if (socketBound) removeFileIfPresent(paths.socketPath);
    releaseLock();
    throw error;
  }
}
