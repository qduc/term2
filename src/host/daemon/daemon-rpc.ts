/**
 * Transport-independent Core Client API v1.0 unary RPC dispatcher (`client-api.md` §§3–9).
 * Delegates error mapping to `daemon-errors.ts` and stream subscriptions to `daemon-streams.ts`.
 */
import { randomUUID } from 'node:crypto';
import type { WireCommand, WireCommandResult, WireSnapshot } from '../../protocol/wire.js';
import {
  CLIENT_API_SCHEMAS,
  type ClientApiSessionListItem,
  type DaemonShutdownParams,
  type DaemonStatusResult,
  type SessionApprovalPolicy,
} from '../../protocol/client-api/client-api-schema.js';
import { CLIENT_API_VERSION } from '../../protocol/client-api/version-negotiation.js';
import type { DirectConnection, DirectHost, Principal, WorkspaceGrant } from '../in-process-direct-types.js';
import type {
  ModelCatalogEntry,
  SafeSettingValue,
  ServerConfiguration,
  ServerWorkspaces,
  SkillSummary,
} from '../server-contracts.js';
import type { GlobalMutationCoordinator } from './global-mutations.js';
import type { SessionIndex } from './session-index.js';
import { asRecord, ClientApiRpcError, mapCommandFailure, parseStrict, requireString } from './daemon-errors.js';
import { openDaemonStream, type StreamRegistration } from './daemon-streams.js';

export { ClientApiRpcError } from './daemon-errors.js';

export type DaemonControlPort = {
  readonly daemonId: string;
  readonly daemonVersion: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly capabilities: readonly string[];
  status(): DaemonStatusResult;
  shutdown(params: DaemonShutdownParams): Promise<{ readonly accepted: boolean; readonly draining?: boolean }>;
  resolveCwdGrant(principal: Principal, cwd: string): Promise<WorkspaceGrant>;
  resolveWorkspaceGrant?(principal: Principal, workspaceId: string): Promise<WorkspaceGrant>;
  setPendingCreatePolicy?(policy: SessionApprovalPolicy | undefined): void;
  forkSession(principal: Principal, sourceSessionId: string): Promise<string>;
  handoffSession(
    principal: Principal,
    sourceSessionId: string,
    input: { readonly name?: string; readonly text?: string },
  ): Promise<string>;
  quota?(principal: Principal, sessionId?: string): Promise<Record<string, unknown>>;
  mcpStatus?(
    principal: Principal,
    input: { readonly workspaceId?: string; readonly sessionId?: string },
  ): Promise<Record<string, unknown>>;
  mcpLogin?(
    principal: Principal,
    input: { readonly serverId: string; readonly workspaceId?: string },
  ): Promise<Record<string, unknown>>;
  sessionFiles?(principal: Principal, sessionId: string): Promise<Record<string, unknown>>;
};

export type DaemonRpcDeps = {
  readonly host: DirectHost;
  readonly sessionIndex: SessionIndex;
  readonly mutations: GlobalMutationCoordinator;
  readonly control: DaemonControlPort;
  readonly configuration?: ServerConfiguration;
  readonly workspaces?: ServerWorkspaces;
  readonly models?: () => readonly ModelCatalogEntry[] | Promise<readonly ModelCatalogEntry[]>;
  readonly skills?: (
    principal: Principal,
    workspaceId?: string,
  ) => readonly SkillSummary[] | Promise<readonly SkillSummary[]>;
};

export class DaemonRpc {
  readonly #sessionLocks = new Map<string, Promise<unknown>>();
  #createLock: Promise<unknown> = Promise.resolve();
  #shutdownReason: 'closed' | 'daemon_shutdown' = 'closed';

  constructor(private readonly deps: DaemonRpcDeps) {}

  markShuttingDown(): void {
    this.#shutdownReason = 'daemon_shutdown';
  }

  #serializeSession<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#sessionLocks.get(sessionId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.catch(() => undefined);
    this.#sessionLocks.set(sessionId, settled);
    void settled.finally(() => {
      if (this.#sessionLocks.get(sessionId) === settled) this.#sessionLocks.delete(sessionId);
    });
    return next;
  }

  openStream(principal: Principal, method: string, rawParams: unknown): Promise<StreamRegistration> {
    return openDaemonStream(
      {
        host: this.deps.host,
        sessionIndex: this.deps.sessionIndex,
        mutations: this.deps.mutations,
        configuration: this.deps.configuration,
        serializeSession: (sessionId, operation) => this.#serializeSession(sessionId, operation),
        shutdownReason: () => this.#shutdownReason,
      },
      principal,
      method,
      rawParams,
    );
  }

  async invoke(principal: Principal, method: string, rawParams: unknown): Promise<Record<string, unknown>> {
    const params = rawParams === undefined ? {} : asRecord(rawParams, method);
    switch (method) {
      case 'protocol.ping':
        return { now: new Date().toISOString() };
      case 'daemon.status':
        return { ...this.deps.control.status(), protocolVersion: CLIENT_API_VERSION };
      case 'daemon.shutdown': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.daemonShutdownParams, params, 'daemon.shutdown');
        return await this.deps.control.shutdown(parsed);
      }
      case 'session.list': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionListParams, params, 'session.list');
        return await this.deps.sessionIndex.list(principal, parsed);
      }
      case 'session.create':
        return await this.#createSession(principal, params);
      case 'session.fork': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionForkParams, params, 'session.fork');
        const sessionId = await this.deps.control.forkSession(principal, parsed.sourceSessionId);
        await this.deps.sessionIndex.seed();
        return { session: await this.#sessionItemOrFallback(principal, sessionId) };
      }
      case 'session.handoff': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionHandoffParams, params, 'session.handoff');
        const sessionId = await this.deps.control.handoffSession(principal, parsed.sourceSessionId, {
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.text !== undefined ? { text: parsed.text } : {}),
        });
        await this.deps.sessionIndex.seed();
        return { session: await this.#sessionItemOrFallback(principal, sessionId) };
      }
      case 'session.close': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionCloseParams, params, 'session.close');
        return await this.#serializeSession(parsed.sessionId, async () => {
          const item = await this.deps.sessionIndex.get(principal, parsed.sessionId);
          if (
            !parsed.force &&
            item &&
            (item.status === 'running' ||
              item.status === 'awaiting_interaction' ||
              (item.activeBackgroundTaskCount ?? 0) > 0)
          ) {
            throw new ClientApiRpcError(
              'busy',
              'Session has active turns or background tasks; pass force: true to close.',
              { retryable: true },
            );
          }
          if (!this.deps.host.closeSession) {
            throw new ClientApiRpcError('unavailable', 'Host cannot close individual sessions.');
          }
          await this.deps.host.closeSession(principal, parsed.sessionId);
          return {};
        });
      }
      case 'session.command':
        return await this.#sessionCommand(principal, params);
      case 'settings.get': {
        const projection = await this.#requireConfig('read')();
        return { revision: projection.revision, settings: { ...projection } };
      }
      case 'settings.update':
        return await this.#settingsUpdate(params);
      case 'models.list':
        return this.deps.models ? { models: await this.deps.models() } : { models: [] };
      case 'providers.presets':
        return await this.#requireConfig('listProviderPresets')();
      case 'providers.upsert':
        return await this.deps.mutations.runSettings(
          async () => (await this.#requireConfig('writeProvider')(params as never)) as Record<string, unknown>,
        );
      case 'providers.delete': {
        const providerId = requireString(params, 'providerId');
        return await this.deps.mutations.runSettings(async () => {
          const res = await this.#requireConfig('deleteProvider')(providerId);
          if (!res.ok) throw new ClientApiRpcError('invalid_request', 'Only custom providers can be deleted.');
          return res as Record<string, unknown>;
        });
      }
      case 'credentials.set': {
        const provider = requireString(params, 'provider');
        const value = requireString(params, 'value');
        return await this.deps.mutations.runSettings(
          async () => (await this.#requireConfig('setCredential')(provider, value)) as Record<string, unknown>,
        );
      }
      case 'credentials.delete': {
        const provider = requireString(params, 'provider');
        return await this.deps.mutations.runSettings(
          async () => (await this.#requireConfig('deleteCredential')(provider)) as Record<string, unknown>,
        );
      }
      case 'oauth.login':
      case 'oauth.select':
      case 'oauth.delete':
        return await this.#handleOAuth(method, params);
      case 'quota.get': {
        const sessionId = typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined;
        return this.deps.control.quota ? await this.deps.control.quota(principal, sessionId) : { quota: null };
      }
      case 'workspaces.list':
        return { workspaces: this.deps.workspaces ? await this.deps.workspaces.list(principal) : [] };
      case 'workspaces.files':
        return await this.#handleWorkspaceFiles(principal, params);
      case 'workspaces.candidates.validate':
        return (await this.#requireWorkspaces('validate')(principal, requireString(params, 'absolutePath'))) as Record<
          string,
          unknown
        >;
      case 'workspaces.candidates.browse':
        return (await this.#requireWorkspaces('browse')(
          principal,
          requireString(params, 'candidateId'),
          typeof params['child'] === 'string' ? params['child'] : undefined,
        )) as Record<string, unknown>;
      case 'workspaces.candidates.select':
        return await this.#handleWorkspaceAccess('select', principal, params);
      case 'workspaces.ssh.hosts':
        return { hosts: this.deps.workspaces?.listSshHosts ? await this.deps.workspaces.listSshHosts(principal) : [] };
      case 'workspaces.ssh.add':
        return { workspace: await this.#requireWorkspaces('addSsh')(principal, params as never) };
      case 'workspaces.remove':
        return (await this.#requireWorkspaces('remove')(principal, requireString(params, 'workspaceId'))) as Record<
          string,
          unknown
        >;
      case 'workspaces.access':
        return await this.#handleWorkspaceAccess('changeAccess', principal, params);
      case 'skills.list': {
        const workspaceId = typeof params['workspaceId'] === 'string' ? params['workspaceId'] : undefined;
        return { skills: this.deps.skills ? await this.deps.skills(principal, workspaceId) : [] };
      }
      case 'mcp.status':
        return this.deps.control.mcpStatus
          ? await this.deps.control.mcpStatus(principal, {
              ...(typeof params['workspaceId'] === 'string' ? { workspaceId: params['workspaceId'] } : {}),
              ...(typeof params['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
            })
          : { servers: [] };
      case 'mcp.login':
        if (!this.deps.control.mcpLogin) throw new ClientApiRpcError('unavailable', 'MCP login unavailable.');
        return await this.deps.control.mcpLogin(principal, {
          serverId: requireString(params, 'serverId'),
          ...(typeof params['workspaceId'] === 'string' ? { workspaceId: params['workspaceId'] } : {}),
        });
      default:
        throw new ClientApiRpcError('invalid_request', `Unknown method "${method}".`);
    }
  }

  #createSession(principal: Principal, rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Serialize creation so pendingCreatePolicy never crosses concurrent session.create calls.
    const next = this.#createLock.then(() => this.#createSessionSerialized(principal, rawParams));
    this.#createLock = next.catch(() => undefined);
    return next;
  }

  async #createSessionSerialized(
    principal: Principal,
    rawParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionCreateParams, rawParams, 'session.create');
    const grant =
      'cwd' in parsed
        ? await this.deps.control.resolveCwdGrant(principal, parsed.cwd)
        : this.deps.control.resolveWorkspaceGrant
        ? await this.deps.control.resolveWorkspaceGrant(principal, parsed.workspaceId)
        : ({ workspaceId: parsed.workspaceId } as unknown as WorkspaceGrant);
    this.deps.control.setPendingCreatePolicy?.(parsed.approvalPolicy);
    let connection: DirectConnection;
    try {
      connection = await this.deps.host.createSession(principal, grant);
    } finally {
      this.deps.control.setPendingCreatePolicy?.(undefined);
    }
    try {
      if (parsed.model) {
        const configured = await connection.send({
          type: 'configure',
          commandId: `create_${randomUUID()}`,
          configuration: { model: { provider: parsed.model.provider, model: parsed.model.model } },
        });
        if (!configured.ok) throw mapCommandFailure(configured);
      }
      const snapshot = connection.snapshot;
      const session = await this.#sessionItemOrFallback(principal, connection.sessionId, snapshot);
      return { session, ...(parsed.includeSnapshot ? { snapshot } : {}) };
    } finally {
      connection.close();
    }
  }

  async #sessionCommand(principal: Principal, rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionCommandParams, rawParams, 'session.command');
    const command = parsed.command as WireCommand;
    let res: WireCommandResult;
    if (this.deps.host.sendCommand) {
      res = await this.deps.host.sendCommand(principal, parsed.sessionId, command);
    } else {
      const connection = await this.deps.host.connect(principal, parsed.sessionId);
      try {
        res = await connection.send(command);
      } finally {
        connection.close();
      }
    }
    if (!res.ok) throw mapCommandFailure(res);
    return { result: res };
  }

  async #settingsUpdate(rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.settingsUpdateParams, rawParams, 'settings.update');
    const write = this.#requireConfig('write');
    return await this.deps.mutations.runSettings(async () => {
      const projection = await write(
        parsed.expectedRevision,
        parsed.changes as { key: string; value: SafeSettingValue }[],
      );
      this.deps.mutations.publishSettings(projection);
      return { committed: true, revision: projection.revision, settings: { ...projection } };
    });
  }

  async #handleOAuth(
    method: 'oauth.login' | 'oauth.select' | 'oauth.delete',
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const provider = requireString(params, 'provider');
    if (provider !== 'codex' && provider !== 'grok') {
      throw new ClientApiRpcError('invalid_request', 'Unsupported OAuth provider.');
    }
    if (method === 'oauth.login') {
      return await this.deps.mutations.runOAuth(
        async () => (await this.#requireConfig('oauthLogin')(provider)) as Record<string, unknown>,
      );
    }
    if (method === 'oauth.select') {
      const accountId = requireString(params, 'accountId');
      return await this.deps.mutations.runOAuth(
        async () => (await this.#requireConfig('oauthSelect')(provider, accountId)) as Record<string, unknown>,
      );
    }
    const accountId = typeof params['accountId'] === 'string' ? params['accountId'] : '';
    return await this.deps.mutations.runOAuth(
      async () => (await this.#requireConfig('oauthDelete')(provider, accountId)) as Record<string, unknown>,
    );
  }

  async #handleWorkspaceFiles(principal: Principal, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (typeof params['workspaceId'] === 'string') {
      if (!this.deps.workspaces?.listFiles) {
        throw new ClientApiRpcError('unavailable', 'Workspace file listing unavailable.');
      }
      return (await this.deps.workspaces.listFiles(principal, params['workspaceId'])) as Record<string, unknown>;
    }
    if (typeof params['sessionId'] === 'string' && this.deps.control.sessionFiles) {
      return await this.deps.control.sessionFiles(principal, params['sessionId']);
    }
    throw new ClientApiRpcError('invalid_request', 'Provide workspaceId or sessionId.');
  }

  async #handleWorkspaceAccess(
    op: 'select' | 'changeAccess',
    principal: Principal,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const access = params['access'];
    if (access !== 'read' && access !== 'read_write') {
      throw new ClientApiRpcError('invalid_request', 'Invalid access mode.');
    }
    const idKey = op === 'select' ? 'candidateId' : 'workspaceId';
    return (await this.#requireWorkspaces(op)(principal, requireString(params, idKey), access)) as Record<
      string,
      unknown
    >;
  }

  async #sessionItemOrFallback(
    principal: Principal,
    sessionId: string,
    snapshot?: WireSnapshot,
  ): Promise<ClientApiSessionListItem> {
    const indexed = await this.deps.sessionIndex.get(principal, sessionId);
    if (indexed) return indexed;
    const now = new Date().toISOString();
    return {
      id: sessionId,
      workspaceId: 'local',
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      latestSequence: snapshot?.seq ?? 0,
      ...(snapshot?.model ? { model: { provider: snapshot.model.provider, model: snapshot.model.model } } : {}),
    };
  }

  #requireConfig<K extends keyof ServerConfiguration>(key: K): NonNullable<ServerConfiguration[K]> {
    const fn = this.deps.configuration?.[key];
    if (!fn) throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
    return fn.bind(this.deps.configuration) as NonNullable<ServerConfiguration[K]>;
  }

  #requireWorkspaces<K extends keyof ServerWorkspaces>(key: K): NonNullable<ServerWorkspaces[K]> {
    const fn = this.deps.workspaces?.[key];
    if (!fn) throw new ClientApiRpcError('unavailable', 'Workspace management unavailable.', { retryable: true });
    return fn.bind(this.deps.workspaces) as NonNullable<ServerWorkspaces[K]>;
  }
}
