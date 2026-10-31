/**
 * `term2 serve` on the direct host. This owns a separate state directory and its
 * own conversations: it never reads or writes the old gateway's trust, replay or
 * session data. One process writes each log, so no other client shares them.
 * Security posture is fixed here, not configured: tools are never auto-approved
 * and never run unsandboxed.
 */
import { appendFile } from 'node:fs/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { defaultServeStateDir } from '../../../source/gateway/serve-args.js';
import { getDefaultShellSandboxRunner } from '../../../source/utils/shell/sandbox/shell-sandbox-runner.js';
import { createDirectServerHost, createServerAuthentication } from '../host/server.js';
import { SqliteReplayLedger } from '../host/server-auth.js';
import type { ServerSessionPresentation, ServerTransportOptions } from '../host/server-contracts.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import { createDirectApplication, type DirectApplication } from './direct-application.js';
import type { DirectAuthority } from './direct-application-workspaces.js';
import { createDirectHostConfig, type DirectHostConfig } from './direct-host-config.js';
import type { DirectLaunchRequest } from './direct-launch-types.js';

type ServeRequest = Extract<DirectLaunchRequest, { readonly kind: 'serve' }>;

class ServeRefused extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The default location holds the old gateway's data, so the direct server takes
 * a sibling leaf. An explicit directory is the operator's, but one that already
 * holds old gateway data is refused before anything in it changes.
 */
function prepareStateDir(requested: string): string {
  const directory =
    requested === defaultServeStateDir() ? path.join(path.dirname(requested), 'gateway-next') : requested;
  if (existsSync(path.join(directory, 'gateway-data'))) {
    throw new ServeRefused(`${directory} holds old gateway data; choose a new --state-dir.`);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function publicKeys({ bffKeys }: ServeRequest['args']): Map<string, string> {
  const keys = new Map<string, string>();
  for (const { kid, pemPath } of bffKeys) {
    try {
      keys.set(kid, readFileSync(pemPath, 'utf8'));
    } catch (error) {
      throw new ServeRefused(`cannot read BFF public key "${kid}" at ${pemPath}: ${messageOf(error)}`);
    }
  }
  return keys;
}

function transportOf({ transport }: ServeRequest['args']): ServerTransportOptions {
  if (transport.kind === 'socket') return { socketPath: transport.socketPath };
  for (const [label, file] of [
    ['tls-cert', transport.certPath],
    ['tls-key', transport.keyPath],
  ] as const) {
    try {
      readFileSync(file);
    } catch (error) {
      throw new ServeRefused(`cannot read --${label} at ${file}: ${messageOf(error)}`);
    }
  }
  return {
    host: transport.host,
    port: transport.port,
    tls: { certPath: transport.certPath, keyPath: transport.keyPath, requireClientCert: false },
  };
}

async function warnIfSandboxUnavailable(): Promise<void> {
  const warn = (type: string, reason?: string): void => {
    const detail = reason ? ` (${reason})` : '';
    process.stderr.write(
      `term2 serve: warning: shell sandbox unavailable: ${type}${detail}; shell tool calls will be refused\n`,
    );
  };
  try {
    const availability = await getDefaultShellSandboxRunner().availability();
    if (availability.type !== 'available') {
      warn(availability.type, 'reason' in availability ? availability.reason : undefined);
    }
  } catch (error) {
    warn('probe_failed', messageOf(error));
  }
}

/** Admission is one authority. Only the local owner reaches a session at all, so a bad assertion subject fails closed. */
function serverAuthority(config: DirectHostConfig, owner: string): DirectAuthority {
  return {
    authorize(principal) {
      if (principal.userId !== owner) throw new DirectProtocolError('forbidden', 'Only the local owner may use this server.');
    },
    resolveGrant: (principal, grant) => config.resolveGrant(principal, grant),
    resolveStored: (root) => config.resolveStored(root),
    // A read grant is a real grant here, enforced by the tools. Stored roots with no grant already threw.
    canRun: () => true,
  };
}

function presentation(app: DirectApplication, config: DirectHostConfig): ServerSessionPresentation {
  return {
    async metadata(principal, snapshot) {
      const { createdAt, updatedAt, earliestSeq } = app.sessionDetails(snapshot.sessionId);
      const root = await app.sessionRoot(principal, snapshot.sessionId);
      return {
        workspaceId: config.workspaceIdFor(root),
        createdAt,
        updatedAt,
        earliestReplayableSequence: earliestSeq,
      };
    },
  };
}

export async function launchServe({ args, selection }: ServeRequest): Promise<number> {
  let stateDir: string;
  let keys: Map<string, string>;
  let transportOptions: ServerTransportOptions;
  try {
    stateDir = prepareStateDir(args.stateDir);
    keys = publicKeys(args);
    if (keys.size === 0 && !args.pairing) {
      throw new ServeRefused('provide at least one --bff-key <kid>=<pem path> or enable --pairing');
    }
    transportOptions = transportOf(args);
  } catch (error) {
    if (!(error instanceof ServeRefused)) throw error;
    process.stderr.write(`term2 serve: ${error.message}\n`);
    return 1;
  }
  await warnIfSandboxUnavailable();

  const { settings, logger } = selection;
  const config = await createDirectHostConfig({
    stateDir,
    localOwnerUserId: args.localOwnerUserId,
    workspaceRoots: args.workspaceRoots,
    allowWrite: args.allowWrite,
    settings,
    logger,
  });
  const ledger = new SqliteReplayLedger(path.join(stateDir, 'replay.sqlite'));
  const app = await createDirectApplication({
    conversationsDir: path.join(stateDir, 'conversations'),
    selection,
    surface: { autoApprove: false, interactive: true, allowUnsandboxed: false },
    authority: serverAuthority(config, args.localOwnerUserId),
  });
  const auditPath = path.join(stateDir, 'server-audit.jsonl');
  const transport = createDirectServerHost(
    {
      host: app.host,
      workspaces: config.workspaces,
      models: () => config.models(),
      configuration: config.configuration,
      presentation: presentation(app, config),
      localOwnerUserId: args.localOwnerUserId,
      audit: (event) => appendFile(auditPath, `${JSON.stringify(event)}\n`, { mode: 0o600 }),
    },
    {
      transport: transportOptions,
      authentication: createServerAuthentication({
        issuer: args.issuer,
        audience: args.audience,
        publicKeys: keys,
        replayLedger: ledger,
        ...(args.pairing
          ? {
              pairing: {
                enabled: true,
                trustFilePath: path.join(stateDir, 'trusted-clients.json'),
                // The OTP is the operator's out-of-band secret, so it never reaches stdout.
                printOtp: (otp: string) => process.stderr.write(`PAIRING OTP: ${otp}\n`),
              },
            }
          : {}),
      }),
    },
  );

  const stopped = new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  let exitCode = 0;
  try {
    await transport.start();
    const endpoint =
      args.transport.kind === 'socket'
        ? `transport=socket path=${args.transport.socketPath}`
        : `transport=tls host=${args.transport.host} port=${args.transport.port}`;
    process.stderr.write(
      `GATEWAY_READY pid=${process.pid} ${endpoint} pairing=${args.pairing ? 'on' : 'off'} workspaceRoots=${args.workspaceRoots.join(',')}\n`,
    );
    await stopped;
  } catch (error) {
    process.stderr.write(`term2 serve: server failed to start: ${messageOf(error)}\n`);
    exitCode = 1;
  } finally {
    // Sessions end only after no client can reach them; the ledger goes last, once nothing verifies.
    try {
      await transport.stop();
      await app.close();
    } finally {
      await config.close?.();
      ledger.close();
    }
  }
  return exitCode;
}
