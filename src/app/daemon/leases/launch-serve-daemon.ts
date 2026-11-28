/**
 * Client launcher for `term2 serve` over the local Term2 daemon (`daemon.serve.start`/`stop`).
 *
 * Connects to the daemon over the local Unix v1.1 socket (`local_leases` capability),
 * requests an HTTP/HTTPS/BFF listener lease backed by the daemon's single
 * `DirectApplication`, conversation store, `GlobalMutationCoordinator`, and `SessionIndex`,
 * forwards `serve.pairing_otp` connection notifications to stderr, prints `GATEWAY_READY`,
 * and releases the lease cleanly on `SIGINT`/`SIGTERM`.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultServeStateDir, type ServeArgs } from '../../../host/gateway/serve-args.js';
import { ClientApiRpcError } from '../../../host/daemon/daemon-errors.js';
import { UnixRpcClient } from '../../../host/daemon/unix-rpc-client.js';
import { CLIENT_API_CAPABILITIES } from '../../../protocol/client-api/client-api-schema.js';
import { connectOrStartDaemon } from '../daemon-bootstrap.js';
import { probeSocketConnectable, resolveDaemonPaths } from '../daemon-paths.js';
import { warnIfSandboxUnavailable } from '../../sandbox-warning.js';
import { loadBffPublicKeys, messageOf, prepareServeStateDir, resolveServeTransport } from './serve-lease-helpers.js';

const DEFAULT_SERVE_ISSUER = 'chatforge-bff';
const DEFAULT_SERVE_AUDIENCE = 'term2-gateway';

export function shouldLaunchServeOverDaemon(args: ServeArgs, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env['TERM2_IN_PROCESS'] === '1') return false;
  if (env['TERM2_DAEMON_MODE'] !== '1') return false;
  // Client API v1.1 `daemon.serve.start` binds the standard issuer/audience; custom BFF
  // issuer/audience deployments stay on the in-process path until exposed in a minor bump.
  return args.issuer === DEFAULT_SERVE_ISSUER && args.audience === DEFAULT_SERVE_AUDIENCE;
}

export async function launchServeOverDaemon(args: ServeArgs): Promise<number> {
  let stateDir: string;
  try {
    stateDir = prepareServeStateDir(args.stateDir);
    const keys = loadBffPublicKeys(args.bffKeys);
    if (keys.size === 0 && !args.pairing) {
      throw new ClientApiRpcError(
        'invalid_request',
        'provide at least one --bff-key <kid>=<pem path> or enable --pairing',
      );
    }
    resolveServeTransport(args.transport);
  } catch (error) {
    if (error instanceof ClientApiRpcError) {
      process.stderr.write(`term2 serve: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  await warnIfSandboxUnavailable('serve', (line) => process.stderr.write(`${line}\n`));

  const hasExplicitDaemonEnv = Boolean(
    process.env['TERM2_DAEMON_SOCKET']?.trim() || process.env['TERM2_CONVERSATIONS_DIR']?.trim(),
  );
  const isIsolatedStateDir = !hasExplicitDaemonEnv && args.stateDir !== defaultServeStateDir();
  const isolatedConversationsDir = isIsolatedStateDir ? path.join(stateDir, 'conversations') : undefined;
  let startedIsolatedDaemon = false;
  if (isIsolatedStateDir) {
    const paths = resolveDaemonPaths({ stateDir, conversationsDir: isolatedConversationsDir });
    startedIsolatedDaemon = !(await probeSocketConnectable(paths.socketPath, 150));
  }

  let connected: Awaited<ReturnType<typeof connectOrStartDaemon>>;
  try {
    connected = await connectOrStartDaemon({
      clientKind: 'serve',
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      capabilities: [...CLIENT_API_CAPABILITIES],
      ...(isIsolatedStateDir ? { stateDir, conversationsDir: isolatedConversationsDir } : {}),
    });
  } catch (error) {
    process.stderr.write(`term2 serve: server failed to start: ${messageOf(error)}\n`);
    return 1;
  }

  const rpc = new UnixRpcClient(connected.socket);
  const removeEvent = rpc.onConnectionEvent((frame) => {
    if (frame.event !== 'serve.pairing_otp') return;
    const code = frame.payload['code'];
    if (typeof code === 'string' && code.length > 0) {
      // The OTP is the operator's out-of-band secret, so it never reaches stdout.
      process.stderr.write(`PAIRING OTP: ${code}\n`);
    }
  });

  let leaseId: string | null = null;
  let exitCode = 0;
  try {
    const started = await rpc.request<{ leaseId: string; stateDir: string; endpoint: string }>('daemon.serve.start', {
      stateDir,
      localOwnerUserId: args.localOwnerUserId,
      allowWrite: args.allowWrite,
      pairing: args.pairing,
      bffKeys: args.bffKeys.map(({ kid, pemPath }) => ({ kid, pemPath })),
      transport: args.transport,
    });
    leaseId = started.leaseId;
    try {
      // Record this CLI process's PID for duplicate-start diagnostics before signaling readiness.
      writeFileSync(path.join(started.stateDir, 'serve.lock.pid'), `${process.pid}\n`, { mode: 0o600 });
    } catch {
      // Diagnostic metadata only; the daemon's SQLite lock is the authority.
    }
    process.stderr.write(
      `GATEWAY_READY pid=${process.pid} ${started.endpoint} pairing=${args.pairing ? 'on' : 'off'}\n`,
    );

    const outcome = await new Promise<'signal' | 'disconnect'>((resolve) => {
      let settled = false;
      const done = (reason: 'signal' | 'disconnect') => {
        if (settled) return;
        settled = true;
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        removeClose();
        resolve(reason);
      };
      const onSignal = () => done('signal');
      process.once('SIGINT', onSignal);
      process.once('SIGTERM', onSignal);
      const removeClose = rpc.onClose(() => done('disconnect'));
    });

    if (outcome === 'disconnect') {
      process.stderr.write('term2 serve: daemon connection closed\n');
      exitCode = 1;
    } else if (leaseId && !rpc.closed) {
      try {
        await rpc.request('daemon.serve.stop', { leaseId }, 15_000);
        leaseId = null;
      } catch {
        // Closing the Unix socket below also triggers daemon-side lease teardown.
      }
      if (startedIsolatedDaemon && !rpc.closed) {
        try {
          const status = await rpc.request<{
            attachedClientCount?: number;
            activeTurnCount?: number;
            activeBackgroundTaskCount?: number;
          }>('daemon.status', {}, 5_000);
          if (
            (status.attachedClientCount ?? 0) <= 1 &&
            (status.activeTurnCount ?? 0) === 0 &&
            (status.activeBackgroundTaskCount ?? 0) === 0
          ) {
            await rpc.request('daemon.shutdown', { mode: 'graceful', whenIdle: true }, 5_000);
          }
        } catch {
          // Another client attached or daemon already stopped; leave it alone.
        }
      }
    }
  } catch (error) {
    if (error instanceof ClientApiRpcError && (error.code === 'busy' || error.code === 'invalid_request')) {
      process.stderr.write(`term2 serve: ${error.message}\n`);
    } else {
      process.stderr.write(`term2 serve: server failed to start: ${messageOf(error)}\n`);
    }
    exitCode = 1;
  } finally {
    removeEvent();
    rpc.close();
  }
  return exitCode;
}
