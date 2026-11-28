/**
 * `term2 serve` as a daemon client (`docs/plans/daemon/spec/transport-unix.md` §5.1).
 *
 * The daemon hosts the HTTP listener over its own sessions for exactly as long as
 * this connection holds the lease: SIGINT/SIGTERM sends `daemon.serve.stop`, and if
 * this process dies the daemon sees EOF and releases the listener anyway. Pairing
 * OTPs arrive only as `serve.pairing_otp` events on this connection and go to stderr,
 * never stdout, as in the in-process launcher.
 */
import path from 'node:path';
import type { UnixEventFrame } from '../../protocol/client-api/client-api-schema.js';
import { DEFAULT_SERVE_AUDIENCE, DEFAULT_SERVE_ISSUER, type ServeArgs } from '../../host/gateway/serve-args.js';
import { UnixRpcClient } from '../../host/daemon/unix-rpc-client.js';
import { warnIfSandboxUnavailable } from '../sandbox-warning.js';
import { messageOf, serveEndpointLabel } from './serve-composition.js';
import { connectOrStartDaemon } from '../daemon/daemon-bootstrap.js';

const STOP_TIMEOUT_MS = 10_000;

/** Paths go to another process with another working directory. */
function absoluteServeParams(args: ServeArgs): Record<string, unknown> {
  const transport =
    args.transport.kind === 'socket'
      ? { kind: 'socket' as const, socketPath: path.resolve(args.transport.socketPath) }
      : {
          kind: 'tls' as const,
          host: args.transport.host,
          port: args.transport.port,
          certPath: path.resolve(args.transport.certPath),
          keyPath: path.resolve(args.transport.keyPath),
        };
  return {
    stateDir: path.resolve(args.stateDir),
    localOwnerUserId: args.localOwnerUserId,
    allowWrite: args.allowWrite,
    pairing: args.pairing,
    bffKeys: args.bffKeys.map(({ kid, pemPath }) => ({ kid, pemPath: path.resolve(pemPath) })),
    transport,
  };
}

export async function launchServeOverDaemon(args: ServeArgs): Promise<number> {
  const stderr = (line: string) => process.stderr.write(`${line}\n`);
  // Client API 1.1 has no issuer/audience on the lease (worth-revisiting.md); refuse rather than ignore them.
  if (args.issuer !== DEFAULT_SERVE_ISSUER || args.audience !== DEFAULT_SERVE_AUDIENCE) {
    stderr(
      'term2 serve: --issuer and --audience are not supported in daemon mode yet; run with TERM2_IN_PROCESS=1 to use them.',
    );
    return 1;
  }
  await warnIfSandboxUnavailable('serve', stderr);

  let rpc: UnixRpcClient;
  try {
    const connected = await connectOrStartDaemon({ clientKind: 'serve' });
    if (!connected.welcome.capabilities.includes('local_leases')) {
      connected.socket.destroy();
      stderr('term2 serve: the running term2 daemon does not offer serve leases; restart it with this version.');
      return 1;
    }
    rpc = new UnixRpcClient(connected.socket);
  } catch (error) {
    stderr(`term2 serve: cannot reach the term2 daemon: ${messageOf(error)}`);
    return 1;
  }

  // Registered before the start request: the first OTP can arrive before its response.
  rpc.onConnectionEvent((frame: UnixEventFrame) => {
    if (frame.event !== 'serve.pairing_otp') return;
    const code = frame.payload['code'];
    if (typeof code === 'string') stderr(`PAIRING OTP: ${code}`);
  });

  let leaseId: string;
  try {
    const started = await rpc.request<{ leaseId: string }>('daemon.serve.start', absoluteServeParams(args));
    leaseId = started.leaseId;
  } catch (error) {
    stderr(`term2 serve: ${messageOf(error)}`);
    rpc.close();
    return 1;
  }

  const outcome = await new Promise<'signal' | 'lost'>((resolve) => {
    process.once('SIGINT', () => resolve('signal'));
    process.once('SIGTERM', () => resolve('signal'));
    rpc.onClose(() => resolve('lost'));
    stderr(
      `GATEWAY_READY pid=${process.pid} ${serveEndpointLabel(args.transport)} pairing=${
        args.pairing ? 'on' : 'off'
      } host=daemon`,
    );
  });
  if (outcome === 'lost') {
    stderr('term2 serve: lost the connection to the term2 daemon; the listener has stopped.');
    return 1;
  }
  try {
    await rpc.request('daemon.serve.stop', { leaseId }, STOP_TIMEOUT_MS);
  } catch (error) {
    // Closing the connection releases the lease too; report, but do not fail the stop.
    stderr(`term2 serve: daemon.serve.stop failed (${messageOf(error)}); releasing by disconnect.`);
  } finally {
    rpc.close();
  }
  return 0;
}
