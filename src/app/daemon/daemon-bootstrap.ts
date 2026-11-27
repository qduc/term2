/**
 * Local client bootstrap & race-safe daemon auto-start (`transport-unix.md` §4.3).
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  CLIENT_API_CAPABILITIES,
  CLIENT_API_SCHEMAS,
  type ClientApiError,
  type ProtocolWelcomeResult,
  type UnixResponseFrame,
} from '../../protocol/client-api/client-api-schema.js';
import { CLIENT_API_MIN_SUPPORTED_VERSION, CLIENT_API_VERSION } from '../../protocol/client-api/version-negotiation.js';
import { installationVersion } from '../../model/providers/fetch/logging-middleware.js';
import { probeSocketConnectable, resolveDaemonPaths, verifySocketOwnership } from './daemon-paths.js';

const AUTO_START_DEADLINE_MS = 10_000;
const BACKOFF_SCHEDULE_MS = [25, 50, 100, 200] as const;

const FORWARDED_DAEMON_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'TERM2_CONVERSATIONS_DIR',
  'TERM2_DAEMON_DIR',
  'TERM2_DAEMON_SOCKET',
  'TERM2_SETTINGS_DIR',
  'TERM2_DATA_DIR',
  'TERM2_LOG_DIR',
  'TERM2_LOG_LEVEL',
  'NODE_ENV',
  'NODE_OPTIONS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

export type DaemonBootstrapOptions = {
  readonly clientKind: string;
  readonly clientVersion?: string;
  readonly capabilities?: readonly string[];
  readonly socketPath?: string;
  readonly conversationsDir?: string;
  readonly stateDir?: string;
  readonly cliEntrypoint?: string;
  readonly allowAutoStart?: boolean;
  readonly allowIdleUpgrade?: boolean;
  readonly deadlineMs?: number;
  readonly env?: NodeJS.ProcessEnv;
};

export type ConnectedDaemonSocket = {
  readonly socket: net.Socket;
  readonly socketPath: string;
  readonly welcome: ProtocolWelcomeResult;
};

function buildDaemonEnv(
  source: NodeJS.ProcessEnv,
  overrides: { conversationsDir?: string; socketPath?: string },
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED_DAEMON_ENV_KEYS) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  // Forward provider API keys and TERM2_* test/config vars without leaking unrelated parent noise.
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (
      key.startsWith('TERM2_') ||
      key.endsWith('_API_KEY') ||
      key.startsWith('OPENAI_') ||
      key.startsWith('ANTHROPIC_') ||
      key.startsWith('GOOGLE_') ||
      key.startsWith('GEMINI_')
    ) {
      out[key] = value;
    }
  }
  if (overrides.conversationsDir) out['TERM2_CONVERSATIONS_DIR'] = overrides.conversationsDir;
  if (overrides.socketPath) out['TERM2_DAEMON_SOCKET'] = overrides.socketPath;
  return out;
}

function spawnDetachedDaemon(
  socketPath: string,
  options: { cliEntrypoint?: string; conversationsDir?: string; stateDir?: string; env: NodeJS.ProcessEnv },
): void {
  const entry = options.cliEntrypoint ?? process.argv[1];
  if (!entry) throw new Error('Cannot determine term2 CLI entrypoint for daemon auto-start.');
  const args = [entry, 'daemon', '--socket', socketPath];
  if (options.stateDir) args.push('--state-dir', options.stateDir);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: buildDaemonEnv(options.env, { conversationsDir: options.conversationsDir, socketPath }),
  });
  child.unref();
}

function connectRawSocket(socketPath: string): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const onError = (error: Error) => {
      socket.off('connect', onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off('error', onError);
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
  });
}

export function sendSingleRpc(
  socket: net.Socket,
  id: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<UnixResponseFrame> {
  return new Promise<UnixResponseFrame>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for daemon response to ${method}.`)));
    }, timeoutMs);
    timer.unref?.();

    const onError = (error: Error) => finish(() => reject(error));
    const onClose = () => finish(() => reject(new Error(`Daemon closed socket during ${method}.`)));
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const frame = CLIENT_API_SCHEMAS.unixFrame.parse(JSON.parse(line));
          if (frame.kind === 'event') continue;
          if (frame.kind !== 'response' || frame.id !== id) {
            finish(() => reject(new Error(`Unexpected frame for ${method}.`)));
            return;
          }
          const remainder = buffer;
          buffer = '';
          finish(() => {
            if (remainder.length > 0) {
              socket.pause();
              socket.unshift(Buffer.from(remainder, 'utf8'));
            }
            resolve(frame);
          });
          return;
        } catch (error) {
          finish(() => reject(error));
          return;
        }
      }
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.write(`${JSON.stringify({ kind: 'request', id, method, params })}\n`, 'utf8');
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForSocketExit(socketPath: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeSocketConnectable(socketPath, 150))) return;
    await sleep(50);
  }
}

async function dialWithAutoStart(
  socketPath: string,
  options: {
    readonly allowAutoStart: boolean;
    readonly deadlineMs: number;
    readonly cliEntrypoint?: string;
    readonly conversationsDir?: string;
    readonly stateDir?: string;
    readonly env: NodeJS.ProcessEnv;
  },
): Promise<net.Socket> {
  verifySocketOwnership(socketPath);
  try {
    return await connectRawSocket(socketPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!options.allowAutoStart || (code !== 'ENOENT' && code !== 'ECONNREFUSED')) {
      throw error;
    }
  }

  const deadline = Date.now() + options.deadlineMs;
  spawnDetachedDaemon(socketPath, {
    cliEntrypoint: options.cliEntrypoint,
    conversationsDir: options.conversationsDir,
    stateDir: options.stateDir,
    env: options.env,
  });

  let attempt = 0;
  let respawned = false;
  while (Date.now() < deadline) {
    const waitMs = BACKOFF_SCHEDULE_MS[Math.min(attempt, BACKOFF_SCHEDULE_MS.length - 1)]!;
    await sleep(waitMs);
    attempt += 1;
    try {
      verifySocketOwnership(socketPath);
      return await connectRawSocket(socketPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      // Peer draining race recovery: re-trigger one fresh spawn if socket stays absent (`transport-unix.md` §4.3).
      if (!respawned && attempt >= 4 && Date.now() + 500 < deadline) {
        respawned = true;
        spawnDetachedDaemon(socketPath, {
          cliEntrypoint: options.cliEntrypoint,
          conversationsDir: options.conversationsDir,
          stateDir: options.stateDir,
          env: options.env,
        });
      }
    }
  }
  throw new Error(`Timed out waiting ${options.deadlineMs}ms for term2 daemon socket at ${socketPath}`);
}

export async function connectOrStartDaemon(options: DaemonBootstrapOptions): Promise<ConnectedDaemonSocket> {
  const env = options.env ?? process.env;
  const paths = resolveDaemonPaths({
    ...(options.socketPath ? { socketPath: options.socketPath } : {}),
    ...(options.conversationsDir ? { conversationsDir: options.conversationsDir } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    env,
  });
  const allowAutoStart = options.allowAutoStart !== false;
  const allowIdleUpgrade = options.allowIdleUpgrade !== false;
  const deadlineMs = options.deadlineMs ?? AUTO_START_DEADLINE_MS;
  const clientVersion = options.clientVersion ?? installationVersion;
  const capabilities = options.capabilities ?? [...CLIENT_API_CAPABILITIES];

  const attemptHandshake = async (): Promise<
    | { readonly ok: true; readonly connected: ConnectedDaemonSocket }
    | { readonly ok: false; readonly error: ClientApiError }
  > => {
    const socket = await dialWithAutoStart(paths.socketPath, {
      allowAutoStart,
      deadlineMs,
      cliEntrypoint: options.cliEntrypoint,
      conversationsDir: paths.conversationsDir,
      stateDir: paths.stateDir,
      env,
    });
    try {
      const response = await sendSingleRpc(socket, 'hello-1', 'protocol.hello', {
        protocolVersion: CLIENT_API_VERSION,
        minSupportedVersion: CLIENT_API_MIN_SUPPORTED_VERSION,
        clientKind: options.clientKind,
        clientVersion,
        capabilities: [...capabilities],
      });
      if (!response.ok) {
        socket.destroy();
        return { ok: false, error: response.error };
      }
      const welcome = CLIENT_API_SCHEMAS.protocolWelcomeResult.parse(response.result);
      return { ok: true, connected: { socket, socketPath: paths.socketPath, welcome } };
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };

  const first = await attemptHandshake();
  if (first.ok) return first.connected;

  if (
    first.error.code === 'protocol_incompatible' &&
    allowIdleUpgrade &&
    allowAutoStart &&
    first.error.details?.['activeTurnCount'] === 0
  ) {
    // Transport spec §4.3: attempt one idle graceful shutdown recovery + respawn.
    try {
      const recoverySocket = await connectRawSocket(paths.socketPath);
      try {
        const shutdownRes = await sendSingleRpc(recoverySocket, 'upgrade-shutdown-1', 'daemon.shutdown', {
          mode: 'graceful',
          whenIdle: true,
        });
        if (shutdownRes.ok) {
          recoverySocket.destroy();
          await waitForSocketExit(paths.socketPath, 3_000);
          const second = await attemptHandshake();
          if (second.ok) return second.connected;
          throw new Error(`Term2 daemon protocol mismatch (${second.error.code}): ${second.error.message}`);
        }
      } finally {
        recoverySocket.destroy();
      }
    } catch {
      // Fall through to report the original actionable mismatch error.
    }
  }

  throw new Error(`Term2 daemon handshake failed (${first.error.code}): ${first.error.message}`);
}
