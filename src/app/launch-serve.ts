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
import { getProfileLabel } from '../config/profiles/labels.js';
import { defaultServeStateDir } from '../host/gateway/serve-args.js';
import { createDirectServerHost, createServerAuthentication } from '../host/server.js';
import { SqliteReplayLedger } from '../host/server-auth.js';
import type { Principal } from '../host/in-process-direct-types.js';
import type { ServerSessionPresentation, ServerTransportOptions } from '../host/server-contracts.js';
import type { WireSnapshot } from '../protocol/wire.js';
import { DirectProtocolError } from '../protocol/errors.js';
import { createDirectApplication, type DirectApplication } from './application.js';
import { prepareDirectSessionConfigurationCommand } from './config-settings.js';
import type { DirectAuthorityFactory } from './application-workspaces.js';
import {
  bindDirectSessionAccess,
  createDirectProductPorts,
  directServeToolPosture,
  DirectGlobalConfiguration,
  DirectWorkspaceAuthority,
} from './host-config.js';
import type { DirectLaunchRequest } from './launch-types.js';
import { warnIfSandboxUnavailable } from './sandbox-warning.js';

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

/**
 * Only the local owner reaches a session at all, so a bad assertion subject fails
 * closed. Every session records its owner and grant, and that record, not its
 * path, is what admits a read or write. `resolveGrant` must stay synchronous:
 * it hands the owner to `createSession` through the caller's async context.
 */
function serverAuthority(grants: DirectWorkspaceAuthority, directory: string, owner: string): DirectAuthorityFactory {
  return (store) => {
    const access = bindDirectSessionAccess({ authority: grants, sessions: store, directory });
    return {
      async authorize(principal, request) {
        if (principal.userId !== owner) {
          throw new DirectProtocolError('forbidden', 'Only the local owner may use this server.');
        }
        await access.authorize(principal, request);
      },
      resolveGrant: (principal, grant) => access.resolveWorkspace(principal, grant),
      resolveStored(root, identity) {
        // Grants are local only, so a recorded SSH target can never match one.
        if (identity && identity.target !== 'local') {
          throw new DirectProtocolError('forbidden', 'This server does not run SSH sessions.');
        }
        return access.resolveStoredRoot(root);
      },
      // A read grant is a real grant here, enforced by the tools. Stored roots with no grant already threw.
      canRun: () => true,
      createSession: (workspace, model, binding) => access.sessions.create(workspace, model, binding),
    };
  };
}

type PresentationOptions = {
  readonly app: DirectApplication;
  readonly directory: string;
  readonly grants: DirectWorkspaceAuthority;
  readonly configuration: DirectGlobalConfiguration;
  readonly allowWrite: boolean;
};

/** Server owner consumes this additive callback after retaining keyed configure
 * fields in HTTP validation and native/protocol admission. No route activation here. */
type DirectServeSessionPresentation = ServerSessionPresentation & {
  prepareConfiguration(
    principal: Principal,
    snapshot: WireSnapshot,
    body: unknown,
  ): ReturnType<typeof prepareDirectSessionConfigurationCommand>;
};

function presentation(options: PresentationOptions): DirectServeSessionPresentation {
  const { app, grants, configuration, allowWrite } = options;
  const owned = (principal: Principal, sessionId: string, seq: number | null) => {
    // Authority stays on the original logical start, validated through the same
    // accepted lineage/cut as the presentation, never on a physical filename alias.
    const binding = app.sessionDetails(sessionId, seq).binding;
    if (binding?.client !== principal.userId) {
      throw new DirectProtocolError('forbidden', 'Workspace grant does not authorize this principal.');
    }
    return { grant: grants.resolveGrant(principal, binding.id) };
  };
  return {
    metadata(principal, snapshot) {
      const { createdAt, updatedAt, earliestSeq } = app.sessionDetails(snapshot.sessionId, snapshot.seq);
      return {
        workspaceId: owned(principal, snapshot.sessionId, snapshot.seq).grant.workspaceId,
        createdAt,
        updatedAt,
        earliestReplayableSequence: earliestSeq,
      };
    },
    async configuration(principal, snapshot) {
      const { grant } = owned(principal, snapshot.sessionId, snapshot.seq);
      const { workspace } = grants.resolveWorkspace(principal, grant);
      const current = await app.sessionConfiguration(snapshot.sessionId);
      const { defaultsRevision } = configuration.read();
      return {
        sessionId: current.sessionId,
        providerId: current.model.provider,
        modelId: current.model.model,
        reasoningEffort: current.reasoningEffort,
        mode: getProfileLabel(current.profileId),
        toolPolicy: directServeToolPosture(workspace.access === 'read_write' && allowWrite),
        configRevision: current.commandRevision,
        defaultsRevision,
      };
    },
    prepareConfiguration(principal, snapshot, body) {
      owned(principal, snapshot.sessionId, snapshot.seq);
      return prepareDirectSessionConfigurationCommand(body);
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
  await warnIfSandboxUnavailable('serve', (line) => process.stderr.write(`${line}\n`));

  // Grants and globals live here, in this state directory, and never in a conversation.
  const grants = new DirectWorkspaceAuthority({
    allowWrite: args.allowWrite,
    allowedRoots: args.workspaceRoots,
    stateDirectory: stateDir,
  });
  const product = createDirectProductPorts();
  const configuration = new DirectGlobalConfiguration(
    product.settings,
    product.credentials,
    product.providers,
    product.oauth,
    product.models,
    args.allowWrite,
  );
  const directory = path.join(stateDir, 'conversations');
  const ledger = new SqliteReplayLedger(path.join(stateDir, 'replay.sqlite'));
  const app = await createDirectApplication({
    conversationsDir: directory,
    selection,
    surface: () => ({ autoApprove: false, interactive: true, allowUnsandboxed: false }),
    approvalAlwaysAsks: true,
    async authorizeModel(next, previous) {
      if (next.provider !== previous.provider) {
        throw new Error('Provider is bound to this session; create a new session to change it.');
      }
      // A same-selection refresh/rollover does not depend on a fresh catalog.
      if (next.model === previous.model) return;
      await configuration.assertModel(next.provider, next.model);
    },
    authority: serverAuthority(grants, directory, args.localOwnerUserId),
  });
  const auditPath = path.join(stateDir, 'server-audit.jsonl');
  const transport = createDirectServerHost(
    {
      host: app.host,
      workspaces: grants,
      models: () => configuration.listModels(),
      configuration,
      presentation: presentation({ app, directory, grants, configuration, allowWrite: args.allowWrite }),
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
      `GATEWAY_READY pid=${process.pid} ${endpoint} pairing=${
        args.pairing ? 'on' : 'off'
      } workspaceRoots=${args.workspaceRoots.join(',')}\n`,
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
      ledger.close();
    }
  }
  return exitCode;
}
