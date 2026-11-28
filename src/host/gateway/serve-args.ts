import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Flag parsing and validation for `term2 serve`, kept free of I/O so the
 * launcher's operator-facing contract is unit-testable. Nothing here reads
 * files or binds sockets; `runServe` owns the effectful composition.
 */

export const DEFAULT_SERVE_ISSUER = 'chatforge-bff';
export const DEFAULT_SERVE_AUDIENCE = 'term2-gateway';

export type ServeSocketTransport = { kind: 'socket'; socketPath: string };
export type ServeTlsTransport = { kind: 'tls'; host: string; port: number; certPath: string; keyPath: string };
export type ServeTransport = ServeSocketTransport | ServeTlsTransport;

export type ServeBffKey = { kid: string; pemPath: string };

export type ServeArgs = {
  stateDir: string;
  transport: ServeTransport;
  localOwnerUserId: string;
  issuer: string;
  audience: string;
  pairing: boolean;
  bffKeys: readonly ServeBffKey[];
  allowWrite: boolean;
};

export type ServeArgsResult = { ok: true; args: ServeArgs } | { ok: false; error: string };

const VALUE_FLAGS = new Set([
  '--state-dir',
  '--socket',
  '--listen',
  '--tls-cert',
  '--tls-key',
  '--local-owner',
  '--issuer',
  '--audience',
  '--bff-key',
]);
const BOOLEAN_FLAGS = new Set(['--pairing', '--allow-write', '--allow-remote']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * Default state root: the XDG state location term2 already uses for
 * `resolveSettingsDirectory`, plus the gateway-specific leaf.
 */
export function defaultServeStateDir(options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  return path.join(env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'term2-nodejs', 'gateway');
}

export function parseServeArgs(argv: readonly string[], defaults: { stateDir?: string } = {}): ServeArgsResult {
  let stateDir = defaults.stateDir ?? defaultServeStateDir();
  let socketPath: string | undefined;
  let listen: string | undefined;
  let tlsCert: string | undefined;
  let tlsKey: string | undefined;
  let localOwner: string | undefined;
  let issuer: string | undefined;
  let audience: string | undefined;
  let pairing = false;
  let allowWrite = false;
  let allowRemote = false;
  const bffKeys: ServeBffKey[] = [];
  const seenKids = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) return { ok: false, error: `unexpected argument "${token}"` };
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { ok: false, error: `${token} requires a value` };
      }
      index += 1;
      if (token === '--state-dir') stateDir = value;
      else if (token === '--socket') socketPath = value;
      else if (token === '--listen') listen = value;
      else if (token === '--tls-cert') tlsCert = value;
      else if (token === '--tls-key') tlsKey = value;
      else if (token === '--local-owner') localOwner = value;
      else if (token === '--issuer') issuer = value;
      else if (token === '--audience') audience = value;
      else if (token === '--bff-key') {
        const separator = value.indexOf('=');
        const kid = separator < 0 ? '' : value.slice(0, separator).trim();
        const pemPath = separator < 0 ? '' : value.slice(separator + 1).trim();
        if (!kid || !pemPath) return { ok: false, error: '--bff-key expects <kid>=<pem path>' };
        if (seenKids.has(kid)) return { ok: false, error: `duplicate --bff-key kid "${kid}"` };
        seenKids.add(kid);
        bffKeys.push({ kid, pemPath });
      }
    } else if (BOOLEAN_FLAGS.has(token)) {
      if (token === '--pairing') pairing = true;
      else if (token === '--allow-write') allowWrite = true;
      else if (token === '--allow-remote') allowRemote = true;
    } else {
      return { ok: false, error: `unknown option "${token}"` };
    }
  }

  if (!localOwner || !localOwner.trim()) {
    return { ok: false, error: '--local-owner <userId> is required' };
  }
  if (!path.isAbsolute(stateDir)) {
    return { ok: false, error: `--state-dir must be an absolute path (got "${stateDir}")` };
  }

  let transport: ServeTransport;
  if (socketPath !== undefined && listen !== undefined) {
    return { ok: false, error: '--socket and --listen are mutually exclusive transports' };
  }
  if (listen !== undefined) {
    if (!tlsCert || !tlsKey) return { ok: false, error: '--listen requires both --tls-cert and --tls-key' };
    const parsed = parseListenSpec(listen);
    if (!parsed.ok) return { ok: false, error: `--listen expects <host:port>: ${parsed.error}` };
    if (!LOOPBACK_HOSTS.has(parsed.host) && !allowRemote) {
      return {
        ok: false,
        error: `refusing non-loopback listen host "${parsed.host}" without --allow-remote`,
      };
    }
    transport = { kind: 'tls', host: parsed.host, port: parsed.port, certPath: tlsCert, keyPath: tlsKey };
  } else {
    if ((tlsCert !== undefined || tlsKey !== undefined) && listen === undefined) {
      return { ok: false, error: '--tls-cert/--tls-key require --listen <host:port>' };
    }
    const resolvedSocket = socketPath ?? path.join(stateDir, 'gateway.sock');
    if (!path.isAbsolute(resolvedSocket)) {
      return { ok: false, error: `--socket must be an absolute path (got "${resolvedSocket}")` };
    }
    if (resolvedSocket.includes('\u0000')) return { ok: false, error: '--socket contains a NUL byte' };
    transport = { kind: 'socket', socketPath: resolvedSocket };
  }

  return {
    ok: true,
    args: {
      stateDir,
      transport,
      localOwnerUserId: localOwner.trim(),
      issuer: issuer?.trim() || DEFAULT_SERVE_ISSUER,
      audience: audience?.trim() || DEFAULT_SERVE_AUDIENCE,
      pairing,
      bffKeys,
      allowWrite,
    },
  };
}

function parseListenSpec(value: string): { ok: true; host: string; port: number } | { ok: false; error: string } {
  const separator = value.lastIndexOf(':');
  if (separator < 0) return { ok: false, error: 'expected "<host>:<port>"' };
  let host = value.slice(0, separator).trim();
  const portText = value.slice(separator + 1).trim();
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return { ok: false, error: `port must be an integer in [1, 65535] (got "${portText}")` };
  }
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  return { ok: true, host: host || '127.0.0.1', port };
}
