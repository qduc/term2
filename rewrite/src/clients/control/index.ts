/** Control/Discord client composition. Host and the public protocol remain the
 * only conversation boundary; the app supplies the Host and owns its disposal.
 */
import type { DirectHost, Principal } from '../../host/in-process-direct-types.js';
import { ControlSocketServer } from './transport.js';
import { createDirectControlSessionPort } from './control-session-port.js';
import type { DirectControlPortOptions, DirectControlSessionPort } from './types.js';

export { createDirectControlSessionPort } from './control-session-port.js';
export type {
  ControlSessionMetadata,
  ControlSubmission,
  DirectControlPortOptions,
  DirectControlSessionPort,
} from './types.js';
export * from './transport.js';
export * from './discord.js';

export type DirectControlSocketOptions = Omit<DirectControlPortOptions, 'connection' | 'controlSocket'> & {
  readonly host: DirectHost;
  readonly principal: Principal;
  readonly sessionId: string;
  readonly name: string;
  readonly runtimeDir?: string;
  /** Process-local opt-in only; never derived from a remotely mutable setting. */
  readonly discordInput?: boolean;
};

export interface DirectControlSocket {
  readonly socket: ControlSocketServer;
  readonly port: DirectControlSessionPort;
  /** App calls this after a real Session rollover/reset. Pauses/drains control
   * admission, authorizes a fresh Host connection and refreshes identity. It
   * neither creates the successor Session nor executes the domain command.
   */
  rebind(sessionId: string): Promise<void>;
  /** Close owned socket/attachment only; never disposes the injected Host. */
  close(): Promise<void>;
}

/** Attach to an existing authorized Session and publish its private v1 socket.
 * Startup failure releases only this attachment's resources. The standalone
 * Discord runner exported here still communicates exclusively through sockets.
 */
export async function startDirectControlSocket(options: DirectControlSocketOptions): Promise<DirectControlSocket> {
  let connection = await options.host.connect(options.principal, options.sessionId);
  let socket: ControlSocketServer;
  try {
    socket = new ControlSocketServer({
      name: options.name,
      runtimeDir: options.runtimeDir,
      discordInput: options.discordInput,
      sessionId: () => connection.sessionId,
    });
  } catch (error) {
    connection.close();
    throw error;
  }
  const makePort = (next: typeof connection) => {
    const port = createDirectControlSessionPort({ ...options, connection: next, controlSocket: socket });
    void port.closed.then(() => socket.unbind(port));
    return port;
  };
  let port: DirectControlSessionPort;
  try {
    port = makePort(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
  socket.bind(port);
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= socket.close().finally(() => port.close());
    return closing;
  };
  try {
    await socket.listen();
    if (port.isClosed) throw new Error('Direct control connection ended during startup');
  } catch (error) {
    await close();
    throw error;
  }
  return {
    socket,
    get port() {
      return port;
    },
    close,
    async rebind(sessionId: string): Promise<void> {
      if (closing) throw new Error('Direct control socket is closing');
      const pause = socket.pauseMutations();
      try {
        await pause.drained;
        const next = await options.host.connect(options.principal, sessionId);
        let replacement: DirectControlSessionPort;
        try {
          if (closing) throw new Error('Direct control socket is closing');
          replacement = makePort(next);
          if (replacement.isClosed) throw new Error('Direct control replacement is closed');
        } catch (error) {
          next.close();
          throw error;
        }
        const previous = port;
        connection = next;
        port = replacement;
        socket.bind(replacement);
        previous.close();
        socket.refreshAdvertisement();
      } finally {
        pause.release();
      }
    },
  };
}
