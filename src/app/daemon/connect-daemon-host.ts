/**
 * Connects (or auto-starts) the local singleton Term2 daemon and returns a
 * `RemoteDirectHost` implementing `DirectHost` / `DirectConnection` over Unix NDJSON.
 */
import type { ProtocolWelcomeResult } from '../../protocol/client-api/client-api-schema.js';
import { UnixRpcClient } from '../../host/daemon/unix-rpc-client.js';
import {
  createRemoteDirectHost,
  type RemoteDirectHost,
  type RemoteDirectHostOptions,
} from '../../host/daemon/remote-direct-host.js';
import { connectOrStartDaemon, type DaemonBootstrapOptions } from './daemon-bootstrap.js';

export type ConnectedRemoteDirectHost = {
  readonly host: RemoteDirectHost;
  readonly socketPath: string;
  readonly welcome: ProtocolWelcomeResult;
};

export async function connectRemoteDirectHost(
  options: DaemonBootstrapOptions & RemoteDirectHostOptions,
): Promise<ConnectedRemoteDirectHost> {
  const connected = await connectOrStartDaemon(options);
  const rpc = new UnixRpcClient(connected.socket);
  const host = createRemoteDirectHost(rpc, {
    ...(options.defaultApprovalPolicy ? { defaultApprovalPolicy: options.defaultApprovalPolicy } : {}),
    ...(options.attachSnapshotTimeoutMs !== undefined
      ? { attachSnapshotTimeoutMs: options.attachSnapshotTimeoutMs }
      : {}),
  });
  return {
    host,
    socketPath: connected.socketPath,
    welcome: connected.welcome,
  };
}
