/**
 * `term2 serve` on the direct host. This owns a separate state directory and its
 * own conversations: it never reads or writes the old gateway's trust, replay or
 * session data. One process writes each log, so no other client shares them.
 * Sandbox isolation stays required (tools never run unsandboxed); approval mode
 * defaults to `off` (ask) and can be configured per session or via safe settings.
 *
 * In daemon mode (`TERM2_DAEMON_MODE=1`, without `TERM2_IN_PROCESS=1`) this process
 * is a client: the singleton daemon hosts the listener over its own sessions for as
 * long as this process holds the lease (`daemon/launch-serve-daemon.ts`).
 */
import path from 'node:path';
import { SqliteReplayLedger } from '../host/server-auth.js';
import type { DirectHostLifecycleEvent } from '../host/in-process-direct-types.js';
import type { ServerTransportOptions } from '../host/server-contracts.js';
import { createDirectApplication } from './application.js';
import { daemonModeEnabled } from './daemon/daemon-mode.js';
import { launchServeOverDaemon } from './serve/launch-serve-daemon.js';
import { createServeSessionIndex } from './serve/serve-session-index.js';
import { bindDirectSessionAccess, createDirectProductPorts, DirectGlobalConfiguration } from './host-config.js';
import { prepareServeSshSurface } from './remote-context.js';
import type { DirectLaunchRequest } from './launch-types.js';
import { warnIfSandboxUnavailable } from './sandbox-warning.js';
import {
  acquireServeStateDirLock,
  createServeGrants,
  createServeHttpTransport,
  messageOf,
  prepareServeStateDir,
  readServePublicKeys,
  SERVE_CAPABILITIES,
  ServeRefused,
  serveEndpointLabel,
  serveSessionAuthority,
  serveTransportOptions,
} from './serve/serve-composition.js';

type ServeRequest = Extract<DirectLaunchRequest, { readonly kind: 'serve' }>;

export async function launchServe(request: ServeRequest): Promise<number> {
  if (daemonModeEnabled()) return await launchServeOverDaemon(request.args);
  return await launchServeInProcess(request);
}

async function launchServeInProcess({ args, selection }: ServeRequest): Promise<number> {
  let stateDir: string;
  let keys: Map<string, string>;
  let transportOptions: ServerTransportOptions;
  let releaseLock: () => void;
  try {
    stateDir = prepareServeStateDir(args.stateDir);
    keys = readServePublicKeys(args.bffKeys);
    if (keys.size === 0 && !args.pairing) {
      throw new ServeRefused('provide at least one --bff-key <kid>=<pem path> or enable --pairing');
    }
    transportOptions = serveTransportOptions(args.transport);
    releaseLock = acquireServeStateDirLock(stateDir);
  } catch (error) {
    if (!(error instanceof ServeRefused)) throw error;
    process.stderr.write(`term2 serve: ${error.message}\n`);
    return 1;
  }
  try {
    await warnIfSandboxUnavailable('serve', (line) => process.stderr.write(`${line}\n`));

    const grants = createServeGrants({
      stateDir,
      allowWrite: args.allowWrite,
      localOwnerUserId: args.localOwnerUserId,
    });
    const product = createDirectProductPorts();
    const configuration = new DirectGlobalConfiguration(
      product.settings,
      product.credentials,
      product.providers,
      product.oauth,
      product.models,
      args.allowWrite,
      SERVE_CAPABILITIES,
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
      // Kept literal for scripts/check-surface-parity.mjs; the daemon uses serveSessionSurface(), the same values.
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
      authority: (store) =>
        serveSessionAuthority(
          bindDirectSessionAccess({ authority: grants, sessions: store, directory }),
          args.localOwnerUserId,
        ),
    });
    // Grant edits must release live sessions; a host without this would keep stale authority.
    const closeWorkspaceSessions = app.host.closeWorkspaceSessions?.bind(app.host);
    if (!closeWorkspaceSessions) throw new Error('The direct host cannot close workspace sessions.');
    const sessionIndexBundle = createServeSessionIndex({
      app,
      grants,
      ownerUserId: args.localOwnerUserId,
      closeWorkspaceSessions: (root) => closeWorkspaceSessions(root),
    });
    lifecycleObserver.current = sessionIndexBundle.observeLifecycle;
    await sessionIndexBundle.index.seed();
    const transport = createServeHttpTransport({
      app,
      grants,
      configuration,
      sessionIndexBundle,
      stateDir,
      localOwnerUserId: args.localOwnerUserId,
      allowWrite: args.allowWrite,
      transport: transportOptions,
      issuer: args.issuer,
      audience: args.audience,
      publicKeys: keys,
      replayLedger: ledger,
      pairing: args.pairing,
      // The OTP is the operator's out-of-band secret, so it never reaches stdout.
      printOtp: (otp) => process.stderr.write(`PAIRING OTP: ${otp}\n`),
    });

    const stopped = new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    });
    let exitCode = 0;
    try {
      await transport.start();
      process.stderr.write(
        `GATEWAY_READY pid=${process.pid} ${serveEndpointLabel(args.transport)} pairing=${
          args.pairing ? 'on' : 'off'
        }\n`,
      );
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
