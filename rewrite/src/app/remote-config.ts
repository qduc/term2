/** SSH endpoint selection only; never loads conversation state or connects. */
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { resolveSSHHost } from '../shared/utils/ssh-config-parser.js';
import type { SSHConfig } from '../tools/ssh-service.js';
import type { Workspace } from '../tools/index.js';

export type DirectRemoteRequest = {
  /** CLI --ssh host or user@host (including an SSH config alias). */
  readonly target: string;
  readonly directory?: string;
  /** Undefined means not explicitly supplied; an explicit 22 still wins over config. */
  readonly port?: number;
  readonly lite?: boolean;
  readonly access: Workspace['access'];
};
export type DirectRemoteConnection = {
  readonly requestedTarget: string;
  /** Canonical identity of the selected SSH endpoint, not a local placeholder. */
  readonly target: string;
  readonly config: Readonly<SSHConfig>;
  readonly directory?: string;
  readonly access: Workspace['access'];
};

/**
 * Resolve CLI identity/port over the existing clean SSH config parser. Reads
 * only ~/.ssh/config by default. An unreadable existing config fails explicitly;
 * a missing config still permits the explicitly requested host, as the old CLI does.
 */
export async function resolveDirectRemoteConnection(
  request: DirectRemoteRequest,
  options: { readonly configContent?: string; readonly username?: string; readonly agent?: string } = {},
): Promise<DirectRemoteConnection> {
  if (request.access !== 'read' && request.access !== 'read_write') throw new Error('Invalid remote workspace access.');
  const { user, host } = parseTarget(request.target);
  if (request.directory !== undefined) text(request.directory, 'Remote directory');
  if (!request.directory && !request.lite) throw new Error('--remote-dir is required when using --ssh');
  const configContent = options.configContent ?? (await readConfig());
  const configured = resolveSSHHost(host, configContent);
  const hostname = unbracket(configured?.hostName || host);
  text(hostname, 'SSH hostname', true);
  const username = user || configured?.user || options.username || process.env.USER || userInfo().username;
  text(username, 'SSH username', true);
  const port = request.port ?? configured?.port ?? 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port.');
  return Object.freeze({
    requestedTarget: request.target,
    target: directRemoteTarget({ host: hostname, username, port }),
    config: Object.freeze({
      host: hostname,
      username,
      port,
      agent: options.agent ?? process.env.SSH_AUTH_SOCK,
      ...(configured?.identityFile ? { identityFile: configured.identityFile } : {}),
    }),
    directory: request.directory,
    access: request.access,
  });
}

/** Derive endpoint identity from the actual SSH connection parameters, never a grant label. */
export function directRemoteTarget(config: Pick<SSHConfig, 'host' | 'username' | 'port'>): string {
  text(config.host, 'SSH hostname', true);
  text(config.username, 'SSH username', true);
  if (/[\/@\[\]]/.test(config.host)) throw new Error('Invalid SSH hostname.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Invalid SSH port.');
  const host = config.host.includes(':') ? `[${config.host}]` : config.host;
  return `ssh://${encodeURIComponent(config.username)}@${host}:${config.port}`;
}

function parseTarget(target: string): { user?: string; host: string } {
  text(target, 'SSH target', true);
  const parts = target.split('@');
  if (parts.length > 2 || parts.some((part) => !part)) throw new Error('SSH target must be host or user@host.');
  return parts.length === 2 ? { user: parts[0], host: unbracket(parts[1]) } : { host: unbracket(parts[0]) };
}

function unbracket(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

function text(value: string, label: string, noWhitespace = false): void {
  if (!value || value.includes('\0') || (noWhitespace && /\s/.test(value))) throw new Error(`Invalid ${label}.`);
}

async function readConfig(): Promise<string> {
  try {
    return await readFile(join(homedir(), '.ssh', 'config'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error('Cannot read SSH configuration.', { cause: error });
  }
}
