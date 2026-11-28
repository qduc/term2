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
import type { ModelCatalogEntry, ServerConfiguration, ServerWorkspaces, SkillSummary } from '../server-contracts.js';
import type { GlobalMutationCoordinator } from './global-mutations.js';
import type { SessionIndex } from './session-index.js';
import { asRecord, ClientApiRpcError, mapCommandFailure, parseStrict, requireString } from './daemon-errors.js';
import { openDaemonStream, type StreamRegistration } from './daemon-streams.js';
import {
  handleLocalLeaseMethod,
  handleMcpLogin,
  handleModelsList,
  handleSessionHandoff,
  handleSessionList,
  handleSettingsGet,
  handleSettingsUpdate,
  isV11,
  parseProviderUpsert,
  type DaemonRpcConnectionContext,
  type DaemonV11ControlPort,
} from './daemon-rpc-v11.js';

export { ClientApiRpcError } from './daemon-errors.js';
export type { DaemonRpcConnectionContext, DaemonV11ControlPort } from './daemon-rpc-v11.js';

type WorkspaceScope = { readonly workspaceId?: string; readonly sessionId?: string };

export type DaemonRpcContext = { readonly protocolVersion?: string; readonly connection?: DaemonRpcConnectionContext };

export type DaemonControlPort = {
  readonly daemonId: string;
  readonly daemonVersion: string;
  readonly startedAt: string;
  readonly pid: number;
  readonly capabilities: readonly string[];
  status(): DaemonStatusResult;
  shutdown(params: DaemonShutdownParams): Promise<void>;
  resolveCwdGrant(principal: Principal, cwd: string): Promise<WorkspaceGrant>;
  resolveWorkspaceGrant?(principal: Principal, workspaceId: string): Promise<WorkspaceGrant>;
  /** Runs `create` so that only the session it creates takes `policy`; a concurrent open of another session does not. */
  withCreatePolicy?<T>(policy: SessionApprovalPolicy | undefined, create: () => Promise<T>): Promise<T>;
  forkSession(principal: Principal, sourceSessionId: string): Promise<string>;
  handoffSession(
    principal: Principal,
    sourceSessionId: string,
    input: { readonly name?: string; readonly text?: string },
  ): Promise<string>;
  setGoal?(principal: Principal, sessionId: string, command: Record<string, unknown>): Promise<void>;
  prepareSkillText?(principal: Principal, sessionId: string, skillName: string, text: string): Promise<string | null>;
  quota?(principal: Principal, sessionId?: string): Promise<Record<string, unknown>>;
  mcpStatus?(
    principal: Principal,
    input: { readonly workspaceId?: string; readonly sessionId?: string },
  ): Promise<Record<string, unknown>>;
  mcpLogin?(
    principal: Principal,
    input: { readonly serverId: string; readonly workspaceId?: string },
  ): Promise<Record<string, unknown>>;
  files?(principal: Principal, scope: WorkspaceScope): Promise<Record<string, unknown>>;
};

export type DaemonRpcDeps = {
  readonly host: DirectHost;
  readonly sessionIndex: SessionIndex;
  readonly mutations: GlobalMutationCoordinator;
  readonly control: DaemonControlPort;
  readonly v11?: DaemonV11ControlPort;
  readonly configuration?: ServerConfiguration;
  readonly workspaces?: ServerWorkspaces;
  readonly models?: () => readonly ModelCatalogEntry[] | Promise<readonly ModelCatalogEntry[]>;
  readonly skills?: (
    principal: Principal,
    scope: WorkspaceScope,
  ) => readonly SkillSummary[] | Promise<readonly SkillSummary[]>;
};

export class DaemonRpc {
  readonly #sessionLocks = new Map<string, Promise<unknown>>();
  #createLock: Promise<unknown> = Promise.resolve();
  #shutdownReason: 'closed' | 'daemon_shutdown' = 'closed';
  #draining = false;

  constructor(private readonly deps: DaemonRpcDeps) {}

  #refuseNewSessionsWhileDraining(): void {
    if (!this.#draining) return;
    throw new ClientApiRpcError('closed', 'Daemon is draining and not accepting new sessions.', { retryable: true });
  }

  markShuttingDown(): void {
    this.#draining = true;
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

  openStream(
    principal: Principal,
    method: string,
    rawParams: unknown,
    context?: DaemonRpcContext & { readonly connectionId?: string },
  ): Promise<StreamRegistration> {
    return openDaemonStream(
      {
        host: this.deps.host,
        sessionIndex: this.deps.sessionIndex,
        mutations: this.deps.mutations,
        configuration: this.deps.configuration,
        readTuiSettings: this.deps.v11?.readTuiSettings,
        serializeSession: (sessionId, operation) => this.#serializeSession(sessionId, operation),
        shutdownReason: () => this.#shutdownReason,
        attachSession: this.deps.v11?.attachSession,
      },
      principal,
      method,
      rawParams,
      context?.protocolVersion,
      context?.connectionId,
    );
  }

  async invoke(
    principal: Principal,
    method: string,
    rawParams: unknown,
    context?: DaemonRpcContext,
  ): Promise<Record<string, unknown>> {
    const params = rawParams === undefined ? {} : asRecord(rawParams, method);
    const allowV11 = isV11(context?.protocolVersion);
    switch (method) {
      case 'protocol.ping':
        return { now: new Date().toISOString() };
      case 'daemon.status':
        return { ...this.deps.control.status(), protocolVersion: CLIENT_API_VERSION };
      case 'daemon.shutdown': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.daemonShutdownParams, params, 'daemon.shutdown');
        await this.deps.control.shutdown(parsed);
        return {};
      }
      case 'session.list':
        return await handleSessionList(this.deps.sessionIndex, this.deps.v11, principal, params, allowV11);
      case 'session.create':
        return await this.#createSession(principal, params);
      case 'session.launch': {
        if (!allowV11) throw new ClientApiRpcError('invalid_request', 'session.launch requires Client API 1.1.');
        if (!this.deps.v11?.launchSession) throw new ClientApiRpcError('unavailable', 'session.launch unavailable.');
        const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionLaunchParams, params, 'session.launch');
        const runLaunch = async () => {
          this.#refuseNewSessionsWhileDraining();
          return await this.deps.v11!.launchSession!(principal, parsed, context?.connection);
        };
        const targetId =
          parsed.selection.kind !== 'new' && parsed.selection.sessionId !== 'last'
            ? parsed.selection.sessionId
            : undefined;
        const next = this.#createLock.then(() =>
          targetId ? this.#serializeSession(targetId, runLaunch) : runLaunch(),
        );
        this.#createLock = next.catch(() => undefined);
        return await next;
      }
      case 'session.fork': {
        const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionForkParams, params, 'session.fork');
        const sessionId = await this.deps.control.forkSession(principal, parsed.sourceSessionId);
        await this.deps.sessionIndex.seed();
        return { session: await this.#sessionItemOrFallback(principal, sessionId) };
      }
      case 'session.handoff': {
        const sessionId = await handleSessionHandoff(this.deps.control, this.deps.v11, principal, params, allowV11);
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
      case 'settings.get':
        return await handleSettingsGet(this.deps.configuration, this.deps.v11, principal, params, allowV11);
      case 'settings.update':
        return await handleSettingsUpdate(
          this.deps.configuration,
          this.deps.mutations,
          this.deps.v11,
          principal,
          params,
          allowV11,
        );
      case 'models.list':
        return await handleModelsList(this.deps.models, this.deps.v11, principal, params, allowV11);
      case 'providers.presets':
        return await this.#requireConfig('listProviderPresets')();
      case 'providers.upsert': {
        const writeInput = parseProviderUpsert(params, allowV11);
        return await this.deps.mutations.runSettings(async () => {
          const res = (await this.#requireConfig('writeProvider')(writeInput)) as Record<string, unknown>;
          await this.#publishCurrentSettings();
          return res;
        });
      }
      case 'providers.delete': {
        const providerId = requireString(params, 'providerId');
        return await this.deps.mutations.runSettings(async () => {
          const res = await this.#requireConfig('deleteProvider')(providerId);
          if (!res.ok) throw new ClientApiRpcError('invalid_request', 'Only custom providers can be deleted.');
          await this.#publishCurrentSettings();
          return res as Record<string, unknown>;
        });
      }
      case 'credentials.set': {
        const provider = requireString(params, 'provider');
        const value = requireString(params, 'value');
        return await this.deps.mutations.runSettings(async () => {
          const res = (await this.#requireConfig('setCredential')(provider, value)) as Record<string, unknown>;
          await this.#publishCurrentSettings();
          return res;
        });
      }
      case 'credentials.delete': {
        const provider = requireString(params, 'provider');
        return await this.deps.mutations.runSettings(async () => {
          const res = (await this.#requireConfig('deleteCredential')(provider)) as Record<string, unknown>;
          await this.#publishCurrentSettings();
          return res;
        });
      }
      case 'oauth.login':
      case 'oauth.select':
      case 'oauth.delete':
        return await this.#handleOAuth(method, params);
      case 'quota.get': {
        for (const key of Object.keys(params)) {
          if (key !== 'sessionId')
            throw new ClientApiRpcError('invalid_request', `Unrecognized key "${key}" in quota.get.`);
        }
        const scope = parseStrict(CLIENT_API_SCHEMAS.skillsListParams, params, 'quota.get');
        return this.deps.control.quota ? await this.deps.control.quota(principal, scope.sessionId) : { quota: null };
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
        const scope = parseStrict(CLIENT_API_SCHEMAS.skillsListParams, params, 'skills.list');
        return { skills: (await this.deps.skills?.(principal, scope)) ?? [] };
      }
      case 'mcp.status': {
        const scope = parseStrict(CLIENT_API_SCHEMAS.skillsListParams, params, 'mcp.status');
        if (!this.deps.control.mcpStatus) throw new ClientApiRpcError('unavailable', 'MCP status unavailable.');
        return await this.deps.control.mcpStatus(principal, scope);
      }
      case 'mcp.login':
        return await handleMcpLogin(this.deps.control.mcpLogin, this.deps.v11, principal, params, allowV11);
      default: {
        const leased = await handleLocalLeaseMethod(this.deps.v11, principal, method, params, context?.connection);
        if (leased !== undefined) return leased;
        throw new ClientApiRpcError('invalid_request', `Unknown method "${method}".`);
      }
    }
  }

  #createSession(principal: Principal, rawParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    // Creates and launches run one at a time. Their launch values do not rely on it: each call carries its own.
    const next = this.#createLock.then(() => this.#createSessionSerialized(principal, rawParams));
    this.#createLock = next.catch(() => undefined);
    return next;
  }

  async #createSessionSerialized(
    principal: Principal,
    rawParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.#refuseNewSessionsWhileDraining();
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionCreateParams, rawParams, 'session.create');
    const grant =
      'cwd' in parsed
        ? await this.deps.control.resolveCwdGrant(principal, parsed.cwd)
        : this.deps.control.resolveWorkspaceGrant
        ? await this.deps.control.resolveWorkspaceGrant(principal, parsed.workspaceId)
        : ({ workspaceId: parsed.workspaceId } as unknown as WorkspaceGrant);
    const create = () => this.deps.host.createSession(principal, grant);
    const connection: DirectConnection = this.deps.control.withCreatePolicy
      ? await this.deps.control.withCreatePolicy(parsed.approvalPolicy, create)
      : await create();
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
    const rawCommand = { ...parsed.command };
    const commandType = rawCommand['type'];
    if (this.#draining && (commandType === 'submit' || commandType === 'retry')) {
      throw new ClientApiRpcError('closed', 'Daemon is draining and not accepting new turns.', { retryable: true });
    }
    if (commandType === 'set_goal') {
      if (!this.deps.control.setGoal) throw new ClientApiRpcError('unavailable', 'Session goal mutation unavailable.');
      await this.deps.control.setGoal(principal, parsed.sessionId, rawCommand);
      return { result: { ok: true, kind: 'accepted' } };
    }
    if ((commandType === 'submit' || commandType === 'preview') && rawCommand['skill'] !== undefined) {
      if (typeof rawCommand['skill'] !== 'string' || rawCommand['skill'].length === 0) {
        throw new ClientApiRpcError('invalid_request', 'Invalid skill name.');
      }
      if (rawCommand['text'] !== undefined && typeof rawCommand['text'] !== 'string') {
        throw new ClientApiRpcError('invalid_request', 'Invalid command text.');
      }
      if (!this.deps.control.prepareSkillText) {
        throw new ClientApiRpcError('unavailable', 'Server-side skill expansion unavailable.');
      }
      const text = typeof rawCommand['text'] === 'string' ? rawCommand['text'] : '';
      const expanded = await this.deps.control.prepareSkillText(principal, parsed.sessionId, rawCommand['skill'], text);
      if (expanded === null) throw new ClientApiRpcError('invalid_request', `Unknown skill "${rawCommand['skill']}".`);
      delete rawCommand['skill'];
      rawCommand['text'] = expanded;
    }
    const command = rawCommand as unknown as WireCommand;
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

  async #publishCurrentSettings(): Promise<void> {
    const read = this.deps.configuration?.read;
    if (!read) return;
    try {
      this.deps.mutations.publishSettings(await read.call(this.deps.configuration));
    } catch {
      // Best-effort settings fanout after mutation commit.
    }
  }

  async #handleOAuth(
    method: 'oauth.login' | 'oauth.select' | 'oauth.delete',
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const provider = requireString(params, 'provider');
    if (provider !== 'codex' && provider !== 'grok') {
      throw new ClientApiRpcError('invalid_request', 'Unsupported OAuth provider.');
    }
    return await this.deps.mutations.runOAuth(async () => {
      const res =
        method === 'oauth.login'
          ? await this.#requireConfig('oauthLogin')(provider)
          : method === 'oauth.select'
          ? await this.#requireConfig('oauthSelect')(provider, requireString(params, 'accountId'))
          : await this.#requireConfig('oauthDelete')(
              provider,
              typeof params['accountId'] === 'string' ? params['accountId'] : '',
            );
      await this.deps.mutations.runSettings(() => this.#publishCurrentSettings());
      return res as Record<string, unknown>;
    });
  }

  async #handleWorkspaceFiles(principal: Principal, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { workspaceId, sessionId } = parseStrict(CLIENT_API_SCHEMAS.workspaceFilesParams, params, 'workspaces.files');
    if (!workspaceId && !sessionId) {
      throw new ClientApiRpcError('invalid_request', 'Provide workspaceId or sessionId.');
    }
    if (workspaceId && this.deps.workspaces?.listFiles) return this.deps.workspaces.listFiles(principal, workspaceId);
    if (this.deps.control.files) return this.deps.control.files(principal, { workspaceId, sessionId });
    throw new ClientApiRpcError('unavailable', 'Workspace file listing unavailable.');
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
    const result = await this.#requireWorkspaces(op)(principal, requireString(params, idKey), access);
    return result as Record<string, unknown>;
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
