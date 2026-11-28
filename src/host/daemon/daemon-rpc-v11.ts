/**
 * Version-gated Client API v1.1 dispatch helpers (`client-api.md` v1.1).
 * Keeps v1.0 strict request validation intact on `1.0` connections while enabling
 * additive v1.1 fields and methods on `>= 1.1` connections.
 */
import {
  CLIENT_API_SCHEMAS,
  type DaemonServeStartParams,
  type ModelsListParamsV11,
  type ProviderUpsertParamsV11,
  type SessionLaunchParams,
  type SettingsUpdateParamsV11,
} from '../../protocol/client-api/client-api-schema.js';
import type { SessionControlBindParams } from '../../protocol/client-api/client-api-schema-v11.js';
import { isClientApiVersionAtLeast } from '../../protocol/client-api/version-negotiation.js';
import type { z } from 'zod';
import type { DirectConnection, DirectReplayConnection, Principal } from '../in-process-direct-types.js';
import type { ProviderWriteInput, SafeSettingValue, ServerConfiguration } from '../server-contracts.js';
import { ClientApiRpcError, parseStrict } from './daemon-errors.js';
import type { GlobalMutationCoordinator } from './global-mutations.js';
import type { SessionIndex } from './session-index.js';

type SessionAcpSetMcpParams = z.infer<typeof CLIENT_API_SCHEMAS.sessionAcpSetMcpParams>;

export type DaemonRpcConnectionContext = {
  readonly connectionId: string;
  emitEvent(event: string, payload: Record<string, unknown>): void;
  onDisconnect(cleanup: () => void | Promise<void>): () => void;
};

export type DaemonV11ControlPort = {
  launchSession?(
    principal: Principal,
    params: SessionLaunchParams,
    connection?: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>>;
  /** Opens a `session.attach`, holding the asking connection to what it launched (`DaemonStreamDeps.attachSession`). */
  attachSession?(
    principal: Principal,
    sessionId: string,
    fromSeq: number | undefined,
    connectionId: string | undefined,
  ): Promise<DirectConnection | DirectReplayConnection>;
  canonicalizeCwd?(principal: Principal, cwd: string): string;
  handoffSessionV11?(
    principal: Principal,
    sourceSessionId: string,
    input: {
      readonly name?: string;
      readonly text?: string;
      readonly model?: { readonly provider: string; readonly model: string };
    },
  ): Promise<string>;
  readTuiSettings?(principal: Principal, sessionId?: string): Promise<Record<string, unknown>>;
  updateScopedSettings?(principal: Principal, params: SettingsUpdateParamsV11): Promise<Record<string, unknown>>;
  listModelsV11?(principal: Principal, params: ModelsListParamsV11): Promise<Record<string, unknown>>;
  mcpLoginV11?(
    principal: Principal,
    input: { readonly serverId: string; readonly workspaceId?: string; readonly handoffUrl?: boolean },
  ): Promise<Record<string, unknown>>;
  serveStart?(
    principal: Principal,
    params: DaemonServeStartParams,
    connection: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>>;
  serveStop?(
    principal: Principal,
    leaseId: string,
    connection: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>>;
  /** Named control socket leases (`transport-unix.md` §5.2). Absent: `session.control.*` answers `unavailable`. */
  controlBind?(
    principal: Principal,
    params: SessionControlBindParams,
    connection: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>>;
  controlRebind?(
    principal: Principal,
    params: { readonly leaseId: string; readonly sessionId: string },
    connection: DaemonRpcConnectionContext,
  ): Promise<Record<string, unknown>>;
  controlUnbind?(
    principal: Principal,
    params: { readonly leaseId: string; readonly pauseForHandoff?: boolean },
    connection: DaemonRpcConnectionContext,
  ): Promise<void>;
  /** `session.acp.set_mcp`: per-session ACP MCP servers, owned by the calling connection. */
  acpSetMcp?(
    principal: Principal,
    params: SessionAcpSetMcpParams,
    connection: DaemonRpcConnectionContext,
  ): Promise<void>;
};

export function isV11(protocolVersion?: string): boolean {
  return isClientApiVersionAtLeast(protocolVersion ?? '1.0', '1.1');
}

function assertEmptyParams(params: Record<string, unknown>, method: string): void {
  const keys = Object.keys(params);
  if (keys.length > 0) {
    throw new ClientApiRpcError('invalid_request', `Unrecognized key "${keys[0]}" in ${method}.`);
  }
}

export async function handleSessionList(
  sessionIndex: SessionIndex,
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  params: Record<string, unknown>,
  allowV11: boolean,
): Promise<Record<string, unknown>> {
  if (!allowV11) {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionListParams, params, 'session.list');
    return await sessionIndex.list(principal, parsed);
  }
  const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionListParamsV11, params, 'session.list');
  if ('cwd' in parsed) {
    if (!v11?.canonicalizeCwd) throw new ClientApiRpcError('unavailable', 'Local cwd listing unavailable.');
    const workspaceRoot = v11.canonicalizeCwd(principal, parsed.cwd);
    return await sessionIndex.list(principal, {
      ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      workspaceRoot,
    });
  }
  return await sessionIndex.list(principal, parsed);
}

export async function handleSettingsGet(
  configuration: ServerConfiguration | undefined,
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  params: Record<string, unknown>,
  allowV11: boolean,
): Promise<Record<string, unknown>> {
  if (!allowV11) {
    assertEmptyParams(params, 'settings.get');
    const read = configuration?.read;
    if (!read) throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
    const projection = await read.call(configuration);
    return { revision: projection.revision, settings: { ...projection } };
  }
  const parsed = parseStrict(CLIENT_API_SCHEMAS.settingsGetParamsV11, params, 'settings.get');
  if (parsed.view === 'tui' || parsed.sessionId !== undefined) {
    if (!v11?.readTuiSettings) throw new ClientApiRpcError('unavailable', 'Scoped TUI settings unavailable.');
    return await v11.readTuiSettings(principal, parsed.sessionId);
  }
  const read = configuration?.read;
  if (!read) throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
  const projection = await read.call(configuration);
  return { revision: projection.revision, settings: { ...projection } };
}

export async function handleSettingsUpdate(
  configuration: ServerConfiguration | undefined,
  mutations: GlobalMutationCoordinator,
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  params: Record<string, unknown>,
  allowV11: boolean,
): Promise<Record<string, unknown>> {
  if (!allowV11) {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.settingsUpdateParams, params, 'settings.update');
    const write = configuration?.write;
    if (!write) throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
    return await mutations.runSettings(async () => {
      const projection = await write.call(
        configuration,
        parsed.expectedRevision,
        parsed.changes as { key: string; value: SafeSettingValue }[],
      );
      mutations.publishSettings(projection);
      return { committed: true, revision: projection.revision, settings: { ...projection } };
    });
  }
  const parsed = parseStrict(CLIENT_API_SCHEMAS.settingsUpdateParamsV11, params, 'settings.update');
  const usesScoped =
    parsed.view === 'tui' ||
    parsed.sessionId !== undefined ||
    parsed.persist !== undefined ||
    parsed.requestId !== undefined ||
    parsed.changes.some((change) => 'reset' in change);
  if (usesScoped) {
    if (!v11?.updateScopedSettings) throw new ClientApiRpcError('unavailable', 'Scoped settings update unavailable.');
    return await v11.updateScopedSettings(principal, parsed);
  }
  const write = configuration?.write;
  if (!write) throw new ClientApiRpcError('unavailable', 'Settings configuration unavailable.', { retryable: true });
  return await mutations.runSettings(async () => {
    const projection = await write.call(
      configuration,
      parsed.expectedRevision,
      parsed.changes as { key: string; value: SafeSettingValue }[],
    );
    mutations.publishSettings(projection);
    return { committed: true, revision: projection.revision, settings: { ...projection } };
  });
}

export function parseProviderUpsert(params: Record<string, unknown>, allowV11: boolean): ProviderWriteInput {
  if (!allowV11) {
    if ('keepApiKey' in params || 'keepBaseUrl' in params) {
      throw new ClientApiRpcError('invalid_request', 'Provider key/baseUrl retention requires Client API 1.1.');
    }
    return params as ProviderWriteInput;
  }
  const parsed: ProviderUpsertParamsV11 = parseStrict(
    CLIENT_API_SCHEMAS.providerUpsertParamsV11,
    params,
    'providers.upsert',
  );
  if (parsed.action === 'toggle') return parsed;
  return {
    action: 'save',
    name: parsed.name,
    type: parsed.type,
    ...(parsed.originalId !== undefined ? { originalId: parsed.originalId } : {}),
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
    ...(parsed.apiKey !== undefined ? { apiKey: parsed.apiKey } : {}),
    ...(parsed.keepApiKey !== undefined ? { keepApiKey: parsed.keepApiKey } : {}),
    ...(parsed.keepBaseUrl !== undefined ? { keepBaseUrl: parsed.keepBaseUrl } : {}),
  };
}

export async function handleSessionHandoff(
  control: {
    handoffSession(
      principal: Principal,
      sourceSessionId: string,
      input: { readonly name?: string; readonly text?: string },
    ): Promise<string>;
  },
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  params: Record<string, unknown>,
  allowV11: boolean,
): Promise<string> {
  if (allowV11) {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionHandoffParamsV11, params, 'session.handoff');
    if (parsed.model) {
      if (!v11?.handoffSessionV11) {
        throw new ClientApiRpcError('unavailable', 'Named-model handoff unavailable.');
      }
      return await v11.handoffSessionV11(principal, parsed.sourceSessionId, {
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.text !== undefined ? { text: parsed.text } : {}),
        model: parsed.model,
      });
    }
    return await control.handoffSession(principal, parsed.sourceSessionId, {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
    });
  }
  const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionHandoffParams, params, 'session.handoff');
  return await control.handoffSession(principal, parsed.sourceSessionId, {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.text !== undefined ? { text: parsed.text } : {}),
  });
}

export async function handleModelsList(
  models: (() => readonly unknown[] | Promise<readonly unknown[]>) | undefined,
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  params: Record<string, unknown>,
  allowV11: boolean,
): Promise<Record<string, unknown>> {
  if (!allowV11) {
    assertEmptyParams(params, 'models.list');
    return models ? { models: await models() } : { models: [] };
  }
  const parsed = parseStrict(CLIENT_API_SCHEMAS.modelsListParamsV11, params, 'models.list');
  if (v11?.listModelsV11) return await v11.listModelsV11(principal, parsed);
  return models ? { models: await models() } : { models: [] };
}

export async function handleMcpLogin(
  mcpLogin:
    | ((
        principal: Principal,
        input: { readonly serverId: string; readonly workspaceId?: string },
      ) => Promise<Record<string, unknown>>)
    | undefined,
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  params: Record<string, unknown>,
  allowV11: boolean,
): Promise<Record<string, unknown>> {
  if (!mcpLogin) throw new ClientApiRpcError('unavailable', 'MCP login unavailable.');
  if (allowV11) {
    const parsed = parseStrict(CLIENT_API_SCHEMAS.mcpLoginParamsV11, params, 'mcp.login');
    if (parsed.handoffUrl) {
      if (!v11?.mcpLoginV11) {
        throw new ClientApiRpcError('unavailable', 'MCP authorization URL handoff is unavailable.');
      }
      return await v11.mcpLoginV11(principal, parsed);
    }
    return await mcpLogin(principal, {
      serverId: parsed.serverId,
      ...(parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    });
  }
  const serverId = typeof params['serverId'] === 'string' && params['serverId'].length > 0 ? params['serverId'] : null;
  if (!serverId) throw new ClientApiRpcError('invalid_request', 'Missing or invalid "serverId".');
  for (const key of Object.keys(params)) {
    if (key !== 'serverId' && key !== 'workspaceId') {
      throw new ClientApiRpcError('invalid_request', `Unrecognized key "${key}" in mcp.login.`);
    }
  }
  const scope =
    params['workspaceId'] !== undefined
      ? parseStrict(CLIENT_API_SCHEMAS.skillsListParams, { workspaceId: params['workspaceId'] }, 'mcp.login')
      : {};
  return await mcpLogin(principal, { serverId, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) });
}

export async function handleLocalLeaseMethod(
  v11: DaemonV11ControlPort | undefined,
  principal: Principal,
  method: string,
  params: Record<string, unknown>,
  connection: DaemonRpcConnectionContext | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (method === 'daemon.serve.start') {
    if (!v11?.serveStart || !connection) {
      throw new ClientApiRpcError('unavailable', 'Daemon serve lease management is unavailable.');
    }
    const parsed = parseStrict(CLIENT_API_SCHEMAS.daemonServeStartParams, params, 'daemon.serve.start');
    return await v11.serveStart(principal, parsed, connection);
  }
  if (method === 'daemon.serve.stop') {
    if (!v11?.serveStop || !connection) {
      throw new ClientApiRpcError('unavailable', 'Daemon serve lease management is unavailable.');
    }
    const parsed = parseStrict(CLIENT_API_SCHEMAS.daemonServeStopParams, params, 'daemon.serve.stop');
    return await v11.serveStop(principal, parsed.leaseId, connection);
  }
  if (method === 'session.control.bind') {
    if (!v11?.controlBind || !connection) {
      throw new ClientApiRpcError('unavailable', 'Daemon control socket leases are unavailable.');
    }
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionControlBindParams, params, method);
    return await v11.controlBind(principal, parsed, connection);
  }
  if (method === 'session.control.rebind') {
    if (!v11?.controlRebind || !connection) {
      throw new ClientApiRpcError('unavailable', 'Daemon control socket leases are unavailable.');
    }
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionControlRebindParams, params, method);
    return await v11.controlRebind(principal, parsed, connection);
  }
  if (method === 'session.control.unbind') {
    if (!v11?.controlUnbind || !connection) {
      throw new ClientApiRpcError('unavailable', 'Daemon control socket leases are unavailable.');
    }
    const parsed = parseStrict(CLIENT_API_SCHEMAS.sessionControlUnbindParams, params, method);
    await v11.controlUnbind(principal, parsed, connection);
    return {};
  }
  if (method === 'session.acp.set_mcp') {
    if (!v11?.acpSetMcp || !connection) {
      throw new ClientApiRpcError('unavailable', 'ACP MCP configuration is unavailable.');
    }
    await v11.acpSetMcp(principal, parseStrict(CLIENT_API_SCHEMAS.sessionAcpSetMcpParams, params, method), connection);
    return {};
  }
  return undefined;
}
