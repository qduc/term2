/**
 * Connection-bound local operator leases (`transport-unix.md` §5, capability
 * `local_leases`, Client API 1.1 Unix only). The Unix server hands each request its
 * connection; a lease lives exactly as long as that connection unless stopped first.
 */
import { CLIENT_API_SCHEMAS } from '../../protocol/client-api/client-api-schema.js';
import type { DaemonServeStartParams } from '../../protocol/client-api/client-api-schema-v11.js';
import type { Principal } from '../in-process-direct-types.js';
import { ClientApiRpcError, parseStrict } from './daemon-errors.js';

/** The Unix connection a request arrived on. */
export type DaemonConnection = {
  readonly id: string;
  /** Runs once when the connection ends for any reason. Returns an unregister function. */
  onClose(listener: () => void): () => void;
  /** Sends a connection-level event (no `streamId`) to this connection only. */
  emit(event: string, payload: Record<string, unknown>): void;
};

export type DaemonLeasePort = {
  serveStart(
    principal: Principal,
    params: DaemonServeStartParams,
    connection: DaemonConnection,
  ): Promise<{ readonly leaseId: string }>;
  serveStop(principal: Principal, leaseId: string, connection: DaemonConnection): Promise<void>;
};

export async function handleLeaseMethod(
  leases: DaemonLeasePort | undefined,
  principal: Principal,
  method: string,
  params: Record<string, unknown>,
  context: { readonly connection?: DaemonConnection } | undefined,
  draining: boolean,
): Promise<Record<string, unknown>> {
  if (draining) {
    throw new ClientApiRpcError('closed', 'Daemon is draining and not accepting new leases.', { retryable: true });
  }
  const connection = context?.connection;
  if (!connection) throw new ClientApiRpcError('invalid_request', 'Leases require a connection-oriented transport.');
  switch (method) {
    case 'daemon.serve.start': {
      const parsed = parseStrict(CLIENT_API_SCHEMAS.daemonServeStartParams, params, method);
      if (!leases) throw new ClientApiRpcError('unavailable', 'Serve leases are unavailable.');
      return await leases.serveStart(principal, parsed, connection);
    }
    case 'daemon.serve.stop': {
      const parsed = parseStrict(CLIENT_API_SCHEMAS.daemonServeStopParams, params, method);
      if (!leases) throw new ClientApiRpcError('unavailable', 'Serve leases are unavailable.');
      await leases.serveStop(principal, parsed.leaseId, connection);
      return {};
    }
    default:
      // Step 14e Part 2 (decisions.md D011): control-socket leases are advertised but not yet backed.
      throw new ClientApiRpcError('unavailable', 'Daemon-owned control sockets are not available yet.');
  }
}
