import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createDirectInProcessHost } from '../host/in-process-direct.js';
import { createDirectServerHost, createServerAuthentication } from '../host/server.js';
import { SqliteReplayLedger } from '../host/server-auth.js';
import type { Principal } from '../host/index.js';
import type { Workspace } from '../tools/index.js';
import { bindDirectSessionAccess, directServeToolPosture, sessionStart } from './direct-host-config-access.js';
import { DirectHostConfigError } from './direct-host-config-error.js';
import {
  createDirectProductPorts,
  defaultServeStateDir,
  parseServeArgs,
} from './adopted/direct-host-config-product.js';
import { DirectGlobalConfiguration } from './direct-host-config-settings.js';
import { DirectWorkspaceAuthority } from './direct-host-config-workspace.js';

type ModelRef = { readonly provider: string; readonly model: string };
type Binding = { readonly client: string; readonly id: string };
type SessionStoreLike = {
  create(workspace: Workspace, model: ModelRef, binding?: Binding): Promise<unknown>;
  open(id: string, binding?: Binding): Promise<unknown>;
  list(
    cursor?: string,
  ): Promise<{ sessions: readonly { id: string; workspace: Workspace; model: ModelRef }[]; cursor?: string }>;
  close(): Promise<void>;
};

/**
 * One direct host and the private server. `stop()` detaches the socket, then
 * disposes the host and closes assertion replay. It does not start unless called,
 * and it refuses the legacy gateway state directory.
 * Serve does not inherit a TUI grant: only persisted roots and --allow-write apply.
 * autoApprove and unsandboxed tools stay off.
 */
export async function startDirectPrivateServer(options: {
  readonly argv: readonly string[];
  readonly conversationsDirectory: string;
  readonly sessions: SessionStoreLike;
  readonly defaultModel: ModelRef;
  readonly capabilities?: (session: unknown) => unknown;
}): Promise<{
  readonly localOwnerUserId: string;
  readonly toolPosture: ReturnType<typeof directServeToolPosture>;
  stop(): Promise<void>;
}> {
  const parsed = parseServeArgs(options.argv);
  if (!parsed.ok) throw new DirectHostConfigError('configuration_invalid', 'startup');
  const args = parsed.args;
  if (path.resolve(args.stateDir) === path.resolve(defaultServeStateDir())) {
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  }
  if (!path.isAbsolute(options.conversationsDirectory))
    throw new DirectHostConfigError('configuration_invalid', 'startup');
  const authority = new DirectWorkspaceAuthority({
    allowWrite: args.allowWrite,
    allowedRoots: args.workspaceRoots,
    stateDirectory: args.stateDir,
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
  const bound = bindDirectSessionAccess({
    authority,
    sessions: options.sessions,
    directory: options.conversationsDirectory,
  });
  const host = createDirectInProcessHost({
    sessions: bound.sessions as never,
    defaultModel: options.defaultModel,
    authorize: bound.authorize,
    resolveWorkspace: bound.resolveWorkspace,
    ...(options.capabilities ? { capabilities: options.capabilities as never } : {}),
  });
  const ledger = new SqliteReplayLedger(path.join(args.stateDir, 'replay.sqlite'));
  const publicKeys = new Map(args.bffKeys.map((key) => [key.kid, readFileSync(key.pemPath, 'utf8')]));
  const authentication = createServerAuthentication({
    issuer: args.issuer,
    audience: args.audience,
    publicKeys,
    replayLedger: ledger,
    ...(args.pairing
      ? {
          pairing: {
            enabled: true,
            trustFilePath: path.join(args.stateDir, 'trusted-clients.json'),
            printOtp: (otp: string) => process.stderr.write(`PAIRING OTP: ${otp}\n`),
          },
        }
      : {}),
  });
  const transport =
    args.transport.kind === 'socket'
      ? { socketPath: args.transport.socketPath }
      : {
          host: args.transport.host,
          port: args.transport.port,
          tls: { certPath: args.transport.certPath, keyPath: args.transport.keyPath, requireClientCert: false },
        };
  const server = createDirectServerHost(
    {
      host,
      workspaces: authority,
      models: () => configuration.listModels(),
      configuration,
      localOwnerUserId: args.localOwnerUserId,
      presentation: {
        metadata(principal: Principal, snapshot: { sessionId: string }) {
          const started = sessionStart(options.conversationsDirectory, snapshot.sessionId);
          if (!started.binding || started.binding.client !== principal.userId) {
            throw new DirectHostConfigError('workspace_authority_revoked', 'authority');
          }
          const grant = authority.resolveGrant(principal, started.binding.id);
          return {
            workspaceId: grant.workspaceId,
            createdAt: started.at,
            updatedAt: started.updatedAt,
            earliestReplayableSequence: started.seq,
          };
        },
        configuration(principal: Principal, snapshot: { sessionId: string }) {
          const started = sessionStart(options.conversationsDirectory, snapshot.sessionId);
          if (!started.binding || started.binding.client !== principal.userId || !started.profileId) {
            throw new DirectHostConfigError('workspace_authority_revoked', 'authority');
          }
          if (!started.provider || !started.model)
            throw new DirectHostConfigError('workspace_authority_revoked', 'authority');
          const grant = authority.resolveWorkspace(principal, authority.resolveGrant(principal, started.binding.id));
          const projection = configuration.read();
          return {
            sessionId: snapshot.sessionId,
            providerId: started.provider,
            modelId: started.model,
            reasoningEffort: started.reasoning ?? 'default',
            mode: started.profileId,
            toolPolicy: directServeToolPosture(grant.workspace.access === 'read_write' && args.allowWrite),
            configRevision: projection.revision,
            defaultsRevision: projection.defaultsRevision,
          };
        },
      },
    },
    { transport, authentication },
  );
  await server.start();
  return {
    localOwnerUserId: args.localOwnerUserId,
    toolPosture: directServeToolPosture(args.allowWrite),
    async stop() {
      try {
        await server.stop();
      } finally {
        try {
          await host.dispose();
        } finally {
          ledger.close();
        }
      }
    },
  };
}
