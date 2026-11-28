/**
 * Daemon-owned Client API v1.1 operations (`client-api.md` §§5.3, 8):
 * - `session.launch`: CLI workspace/selection/override admission before attach.
 * - Scoped TUI settings read/update (`view: "tui"`, optional `sessionId`, explicit `reset`, strict secret & URL redaction).
 * - Per-provider `models.list` with independent refresh and favorites/nicknames projection.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { getProfileMetadata } from '../../config/profiles/active-profile.js';
import { decodeStoredCustomProviderConfigs } from '../../config/settings/custom-provider-normalization.js';
import { SENSITIVE_SETTING_KEYS, SETTING_KEYS } from '../../config/settings/settings-schema.js';
import { isSecretSetting } from '../../config/settings/settings-ui-metadata.js';
import type { Principal, WorkspaceGrant } from '../../host/in-process-direct-types.js';
import { ClientApiRpcError, type DaemonV11ControlPort } from '../../host/daemon/daemon-rpc.js';
import type { GlobalMutationCoordinator } from '../../host/daemon/global-mutations.js';
import type { SessionIndex } from '../../host/daemon/session-index.js';
import { ModelCatalogSession } from '../../model/models/model-catalog-session.js';
import { getFavoriteModelInfos } from '../../model/models/model-favorites.js';
import { getNicknameEntries } from '../../model/models/model-nicknames.js';
import { catalogDetails } from '../../model/providers/model-catalog/catalog-details.js';
import type {
  ClientApiSessionListItem,
  ModelsListParamsV11,
  SessionLaunchParams,
  SettingsUpdateParamsV11,
} from '../../protocol/client-api/client-api-schema.js';
import { storedSessionId } from '../../protocol/session-id.js';
import type { DirectCommandConfiguration } from '../../session/command-types.js';
import { createDurableGoal } from '../../session/goal.js';
import type { DirectApplication } from '../application.js';
import { localGrant, requireLocalCaller } from '../application-workspaces.js';
import type { DirectApprovalMode } from '../config-settings.js';
import type { DirectGlobalConfiguration } from '../host-config.js';
import type { SettingsService } from '../settings.js';
import type { DaemonLaunchValues } from './daemon-session-ops.js';

const FORBIDDEN_SETTING_KEYS = new Set<string>(['providers', 'hooks', 'hooks.commands', 'mcp', 'mcp.servers']);
const URL_SETTING_KEYS = new Set<string>(['webSearch.firecrawl.baseUrl', 'webSearch.searxng.baseUrl']);
const SAFE_TUI_SETTING_KEYS = (Object.values(SETTING_KEYS) as readonly string[]).filter(
  (key) =>
    !FORBIDDEN_SETTING_KEYS.has(key) &&
    !SENSITIVE_SETTING_KEYS.has(key) &&
    !key.startsWith('providers.') &&
    !key.startsWith('mcp.') &&
    !key.startsWith('hooks.commands') &&
    !isSecretSetting(key),
);
const SAFE_TUI_SETTING_SET = new Set<string>(SAFE_TUI_SETTING_KEYS);
const MAX_CACHED_RECEIPTS = 128;

function isSafeTuiSettingKey(key: string): boolean {
  return SAFE_TUI_SETTING_SET.has(key);
}

function safeDisplayBaseUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function sanitizeSettingProjectionValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if ((URL_SETTING_KEYS.has(key) || key.endsWith('.baseUrl')) && typeof value === 'string') {
    return safeDisplayBaseUrl(value) ?? null;
  }
  return value;
}

export type DaemonV11Deps = {
  readonly app: DirectApplication;
  readonly sessionIndex: SessionIndex;
  readonly mutations: GlobalMutationCoordinator;
  readonly configuration: DirectGlobalConfiguration;
  readonly productSettings: SettingsService;
  readonly localWorkspaceIdForRoot: (root: string) => string;
  readonly recordLocalWorkspace: (root: string) => void;
  readonly resolveWorkspaceRoot: (workspaceId: string) => string;
  /** Runs `start` so that only the session it starts takes `values` (`DaemonLaunchPolicies.withLaunch`). */
  readonly withLaunchValues: <T>(values: DaemonLaunchValues, start: () => Promise<T>) => Promise<T>;
  /** Refuses a launch whose client mode the live session's surface does not match. */
  readonly admitLaunch?: (sessionId: string, params: SessionLaunchParams) => void | Promise<void>;
  readonly sessionItemOrFallback: (principal: Principal, sessionId: string) => Promise<ClientApiSessionListItem>;
  readonly recentSettingsReceipts: Map<string, Record<string, unknown>>;
};

function canonicalizeLocalCwd(cwd: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(cwd);
  } catch {
    throw new ClientApiRpcError('invalid_request', `Workspace directory does not exist: ${cwd}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new ClientApiRpcError('invalid_request', `Workspace path is not a directory: ${cwd}`);
  }
  return resolved;
}

function mapLaunchConfigError(error: unknown): never {
  if (error instanceof ClientApiRpcError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('background work') || message.toLowerCase().includes('busy')) {
    throw new ClientApiRpcError('busy', message, { retryable: true });
  }
  throw new ClientApiRpcError('invalid_request', message);
}

async function launchDaemonSession(
  deps: DaemonV11Deps,
  principal: Principal,
  params: SessionLaunchParams,
): Promise<Record<string, unknown>> {
  requireLocalCaller(principal);
  if ('ssh' in params) {
    throw new ClientApiRpcError('unavailable', 'SSH session launch over daemon is not enabled yet.');
  }

  const root = 'cwd' in params ? canonicalizeLocalCwd(params.cwd) : deps.resolveWorkspaceRoot(params.workspaceId);
  const workspaceId = deps.localWorkspaceIdForRoot(root);
  const grant: WorkspaceGrant = localGrant(root);

  const launchConfig: DirectCommandConfiguration = {
    ...(params.model ? { model: { provider: params.model.provider, model: params.model.model } } : {}),
    ...(params.reasoning ? { reasoning: params.reasoning } : {}),
    ...(params.profileId ? { profileId: params.profileId } : {}),
  };
  const approvalMode = params.approvalMode as DirectApprovalMode | undefined;
  const launchFlags =
    params.requireSandbox !== undefined || params.clientMode !== undefined
      ? {
          ...(params.requireSandbox !== undefined ? { requireSandbox: params.requireSandbox } : {}),
          ...(params.clientMode !== undefined ? { clientMode: params.clientMode } : {}),
        }
      : undefined;

  let sessionId: string;
  let forkedFrom: string | undefined;
  let conn: { readonly sessionId: string; close(): void };
  const createdFresh = params.selection.kind === 'new' || params.selection.kind === 'fork';
  const withLaunch = (open: () => Promise<typeof conn>, target?: string): Promise<typeof conn> =>
    deps.withLaunchValues(
      {
        ...(params.approvalPolicy ? { policy: params.approvalPolicy } : {}),
        ...(launchFlags ? { flags: launchFlags } : {}),
        ...(target ? { sessionId: target } : {}),
      },
      open,
    );

  if (params.selection.kind === 'new') {
    deps.recordLocalWorkspace(root);
    conn = await withLaunch(() => deps.app.host.createSession(principal, grant));
    sessionId = conn.sessionId;
  } else {
    const stored = await deps.app.listStoredSessions();
    let targetSummary: (typeof stored.sessions)[number] | undefined;
    if (params.selection.sessionId === 'last') {
      const inWorkspace = stored.sessions
        .filter((item) => item.workspace.target === 'local' && item.workspace.root === root)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      targetSummary = inWorkspace[0];
      if (!targetSummary) {
        throw new ClientApiRpcError('not_found', 'No saved sessions found in this workspace.');
      }
    } else {
      const requestedId = params.selection.sessionId;
      const normalized = storedSessionId(requestedId);
      targetSummary = stored.sessions.find((item) => item.id === normalized || item.id === requestedId);
      if (!targetSummary) {
        throw new ClientApiRpcError('not_found', `Session "${requestedId}" not found.`);
      }
      if (targetSummary.workspace.target !== 'local' || targetSummary.workspace.root !== root) {
        throw new ClientApiRpcError('forbidden', 'Session belongs to a different workspace.', {
          details: {
            sessionId: targetSummary.id,
            sessionWorkspace: { root: targetSummary.workspace.root },
            requestedWorkspace: { root },
          },
        });
      }
    }
    // Only record the workspace once selection lookup & boundary checks pass.
    deps.recordLocalWorkspace(root);
    if (params.selection.kind === 'fork') {
      forkedFrom = targetSummary.id;
      sessionId = await deps.app.forkSession(targetSummary.id);
      await deps.sessionIndex.seed();
    } else {
      sessionId = targetSummary.id;
    }
    const target = sessionId;
    conn = await withLaunch(() => deps.app.host.connect(principal, target), target);
  }
  try {
    await deps.admitLaunch?.(sessionId, params);
    if (approvalMode !== undefined || Object.keys(launchConfig).length > 0) {
      try {
        await deps.app.applyLaunchConfiguration(sessionId, launchConfig, approvalMode);
      } catch (error) {
        mapLaunchConfigError(error);
      }
    }
    const liveSettings = deps.app.liveSettings(sessionId);
    if (liveSettings) {
      if (params.showReview !== undefined) liveSettings.set('shell.showReview', params.showReview, { persist: false });
      if (params.sandboxEnabled !== undefined) {
        liveSettings.set('sandbox.enabled', params.sandboxEnabled, { persist: false });
      }
      if (params.requireSandbox) liveSettings.set('sandbox.enabled', true, { persist: false });
    }
    if (params.goal) {
      await deps.app.setGoal(sessionId, createDurableGoal(params.goal.text, params.goal.successCriteria), 'launcher');
    }
    const details = deps.app.sessionDetails(sessionId);
    const profileMetadata = details.profileId ? getProfileMetadata(details.profileId) : undefined;
    const session = await deps.sessionItemOrFallback(principal, sessionId);
    return {
      session,
      workspace: { workspaceId, root, target: 'local' as const },
      ...(profileMetadata ? { profileMetadata: { ...profileMetadata } } : {}),
      ...(forkedFrom ? { forkedFrom } : {}),
    };
  } catch (error) {
    conn.close();
    if (createdFresh) {
      await deps.app.host.closeSession?.(principal, sessionId).catch(() => undefined);
    }
    throw error;
  } finally {
    conn.close();
  }
}

async function readDaemonTuiSettings(
  deps: DaemonV11Deps,
  principal: Principal,
  sessionId?: string,
): Promise<Record<string, unknown>> {
  requireLocalCaller(principal);
  const webProjection = await deps.configuration.read();
  const buildFrom = (targetSettings: SettingsService, rebuilt: boolean, profileId: string | null) => {
    const entries: Record<
      string,
      {
        readonly value: unknown;
        readonly defaultValue: unknown;
        readonly source: string;
        readonly startupOverride?: unknown;
        readonly runtimeModifiable: boolean;
      }
    > = {};
    for (const key of SAFE_TUI_SETTING_KEYS) {
      const value = sanitizeSettingProjectionValue(key, targetSettings.getDynamic(key));
      const defaultValue = sanitizeSettingProjectionValue(key, targetSettings.getDefault(key));
      const source = targetSettings.getSource(key);
      const startupOverride = targetSettings.getStartupOverride(key);
      entries[key] = {
        value,
        defaultValue,
        source,
        ...(startupOverride !== undefined
          ? { startupOverride: sanitizeSettingProjectionValue(key, startupOverride) }
          : {}),
        runtimeModifiable: targetSettings.isRuntimeModifiable(key),
      };
    }
    const customStored = new Map(
      decodeStoredCustomProviderConfigs(deps.productSettings.getDynamic('providers')).map((entry) => [entry.id, entry]),
    );
    const providers = webProjection.settings.providers.map((provider) => {
      const custom = customStored.get(provider.id);
      const displayUrl = safeDisplayBaseUrl(custom?.baseUrl);
      return {
        ...provider,
        ...(custom ? { type: custom.type, hasBaseUrl: Boolean(custom.baseUrl) } : {}),
        ...(displayUrl ? { baseUrl: displayUrl } : {}),
      };
    });
    const sessionAccounts = sessionId
      ? {
          codex: deps.app.sessionAccount(sessionId, 'codex'),
          grok: deps.app.sessionAccount(sessionId, 'grok'),
        }
      : undefined;
    const payload = {
      scope: sessionId ? ('session' as const) : ('global' as const),
      ...(sessionId ? { sessionId, rebuilt, profileId } : {}),
      entries,
      providers,
      credentials: webProjection.settings.credentials,
      oauthAccounts: webProjection.settings.oauthAccounts,
      ...(sessionAccounts ? { sessionAccounts } : {}),
      safety: webProjection.settings.safety,
    };
    const revision = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    return { revision, settings: payload };
  };

  if (!sessionId) {
    return buildFrom(deps.productSettings, false, String(deps.productSettings.get('app.activeProfileId')));
  }
  // Never call host.connect() on read: only inspect already-live sessions so dormant/closed sessions stay closed.
  const details = deps.app.sessionDetails(sessionId);
  if (!details.settings) {
    throw new ClientApiRpcError('not_found', `Session "${sessionId}" is not currently active.`);
  }
  return buildFrom(details.settings, details.rebuilt, details.profileId);
}

async function updateDaemonScopedSettings(
  deps: DaemonV11Deps,
  principal: Principal,
  params: SettingsUpdateParamsV11,
): Promise<Record<string, unknown>> {
  requireLocalCaller(principal);
  for (const change of params.changes) {
    if (!isSafeTuiSettingKey(change.key)) {
      throw new ClientApiRpcError('invalid_request', `Setting "${change.key}" cannot be modified via settings.update.`);
    }
  }
  const persist = params.persist !== false;
  const receiptKey = params.requestId ? `${params.sessionId ?? 'global'}:${params.requestId}` : undefined;
  return await deps.mutations.runSettings(async () => {
    if (receiptKey && deps.recentSettingsReceipts.has(receiptKey)) {
      return deps.recentSettingsReceipts.get(receiptKey)!;
    }
    const current = await readDaemonTuiSettings(deps, principal, params.sessionId);
    if (current['revision'] !== params.expectedRevision) {
      throw new ClientApiRpcError('stale_revision', 'Settings revision is stale.', {
        details: { currentRevision: current['revision'], projection: current },
      });
    }
    const live = params.sessionId ? deps.app.liveSettings(params.sessionId) : null;
    if (params.sessionId && !live) {
      throw new ClientApiRpcError('not_found', `Session "${params.sessionId}" is not currently active.`);
    }
    const target = live ?? deps.productSettings;
    if (!persist) {
      for (const change of params.changes) {
        if (!target.isRuntimeModifiable(change.key)) {
          throw new ClientApiRpcError(
            'invalid_request',
            `Setting "${change.key}" requires persistence and restart; temporary updates are not allowed.`,
          );
        }
      }
    }
    // Pre-snapshot previous values so any mid-batch validation error rolls back in-memory state cleanly.
    const previousValues = params.changes.map((change) => ({
      key: change.key,
      hadValue: target.getDynamic(change.key),
    }));
    try {
      const toSet = params.changes.filter((c): c is { key: string; value: unknown } => !('reset' in c));
      const toReset = params.changes.filter((c): c is { key: string; reset: true } => 'reset' in c);
      if (persist) {
        if (toSet.length > 0) {
          const result = deps.productSettings.setPersistentDynamicTransaction(toSet);
          if (result.status !== 'saved') {
            throw new ClientApiRpcError('unavailable', 'Could not persist settings batch.');
          }
          if (live) {
            for (const { key, value } of toSet) {
              if (live.isRuntimeModifiable(key)) live.setDynamic(key, value, { persist: false });
            }
          }
        }
        for (const { key } of toReset) {
          const result = deps.productSettings.reset(key);
          if (result.status !== 'saved') {
            throw new ClientApiRpcError('unavailable', `Could not reset setting "${key}".`);
          }
          if (live && live.isRuntimeModifiable(key)) {
            live.setDynamic(key, live.getDefault(key), { persist: false });
          }
        }
      } else {
        for (const change of params.changes) {
          if ('reset' in change) target.setDynamic(change.key, target.getDefault(change.key), { persist: false });
          else target.setDynamic(change.key, change.value, { persist: false });
        }
      }
    } catch (error) {
      if (!persist) {
        for (const { key, hadValue } of previousValues) {
          try {
            target.setDynamic(key, hadValue, { persist: false });
          } catch {
            // Best-effort rollback of in-memory temporary change.
          }
        }
      }
      if (error instanceof ClientApiRpcError) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ClientApiRpcError('invalid_request', `Invalid setting update: ${msg}`);
    }
    // Always notify settings subscribers (both persisted global changes and session-scoped temporary changes).
    deps.mutations.publishSettings(await deps.configuration.read());
    const updated = await readDaemonTuiSettings(deps, principal, params.sessionId);
    const response = {
      committed: true,
      persisted: persist,
      revision: updated['revision'],
      settings: updated['settings'],
    };
    if (receiptKey) {
      if (deps.recentSettingsReceipts.size >= MAX_CACHED_RECEIPTS) {
        const oldest = deps.recentSettingsReceipts.keys().next().value;
        if (oldest) deps.recentSettingsReceipts.delete(oldest);
      }
      deps.recentSettingsReceipts.set(receiptKey, response);
    }
    return response;
  });
}

async function listDaemonModelsV11(
  deps: DaemonV11Deps,
  principal: Principal,
  params: ModelsListParamsV11,
): Promise<Record<string, unknown>> {
  requireLocalCaller(principal);
  const favorites = getFavoriteModelInfos(deps.productSettings).map((entry) => `${entry.provider}/${entry.id}`);
  const nicknames = Object.fromEntries(
    getNicknameEntries(deps.productSettings).map((entry) => [
      entry.nickname,
      `${entry.provider}/${entry.modelId}${entry.reasoningEffort ? `:${entry.reasoningEffort}` : ''}`,
    ]),
  );
  if (!params.provider) {
    const models = await deps.configuration.listModels();
    return { models, favorites, nicknames };
  }
  const catalog = new ModelCatalogSession({
    settingsService: deps.productSettings,
    loggingService: deps.productSettings.getLoggingService(),
  });
  if (params.refresh) catalog.invalidate(params.provider);
  try {
    const loaded = await catalog.load(params.provider);
    const models = loaded.models.map((model) => ({
      provider: params.provider!,
      id: model.id,
      ...(typeof model.name === 'string' ? { name: model.name } : {}),
      ...(typeof model.default_reasoning_level === 'string'
        ? { default_reasoning_level: model.default_reasoning_level }
        : {}),
      ...(typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
        ? { contextWindow: model.contextWindow }
        : {}),
      ...catalogDetails(params.provider!, model.id),
    }));
    return { provider: params.provider, models, favorites, nicknames };
  } catch {
    return {
      provider: params.provider,
      models: [],
      error: 'Provider model catalog unavailable.',
      favorites,
      nicknames,
    };
  }
}

export function createDaemonV11Port(
  deps: Omit<DaemonV11Deps, 'sessionItemOrFallback' | 'recentSettingsReceipts'>,
): DaemonV11ControlPort {
  const fullDeps: DaemonV11Deps = {
    ...deps,
    recentSettingsReceipts: new Map(),
    async sessionItemOrFallback(principal, sessionId) {
      const indexed = await deps.sessionIndex.get(principal, sessionId);
      if (indexed) return indexed;
      const now = new Date().toISOString();
      return { id: sessionId, workspaceId: 'local', status: 'idle', createdAt: now, updatedAt: now, latestSequence: 0 };
    },
  };
  return {
    launchSession: (principal, params) => launchDaemonSession(fullDeps, principal, params),
    canonicalizeCwd: (principal, cwd) => {
      requireLocalCaller(principal);
      return canonicalizeLocalCwd(cwd);
    },
    handoffSessionV11: (principal, sourceSessionId, input) => {
      requireLocalCaller(principal);
      return deps.app.handoff(sourceSessionId, input.model, input.text ?? '');
    },
    readTuiSettings: (principal, sessionId) => readDaemonTuiSettings(fullDeps, principal, sessionId),
    updateScopedSettings: (principal, params) => updateDaemonScopedSettings(fullDeps, principal, params),
    listModelsV11: (principal, params) => listDaemonModelsV11(fullDeps, principal, params),
  };
}
