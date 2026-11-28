/**
 * Client API v1.1 Unix daemon backend for the interactive TUI (`docs/plans/daemon/zoom/tui.md`).
 * Connects via `connectRemoteDirectHost` (`minSupportedVersion: '1.1'`), launches/resumes/forks
 * through `session.launch`, keeps synchronous `ISettingsService` projections synced via
 * `DaemonTuiSettingsStore`, and supports bounded reconnect on dropped connections / `resync_required`.
 */
import fs from 'node:fs';
import { stderr, stdout } from 'node:process';
import type { MenuModelInfo, MenuPathEntry } from '../../clients/tui/integration.js';
import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';
import type { RemoteDirectHost } from '../../host/daemon/remote-direct-host.js';
import { getModelContextWindow } from '../../model/providers/model-catalog/catalog.js';
import type { SessionLaunchResult } from '../../protocol/client-api/client-api-schema.js';
import { displaySessionId } from '../../protocol/session-id.js';
import type { WireCommand, WireSnapshot } from '../../protocol/wire.js';
import type { DurableGoal } from '../../session/goal.js';
import type { McpStatusView } from '../../tools/mcp/mcp-status.js';
import type { McpServerSnapshot } from '../../tools/mcp/mcp-tool-source.js';
import { LOCAL_PRINCIPAL } from '../application-workspaces.js';
import type { DirectControlBridge } from '../launch-control.js';
import { createDaemonControlBridge, type DaemonControlBridge } from './leases/control-bridge.js';
import type { UnixRpcClient } from '../../host/daemon/unix-rpc-client.js';
import type { TuiBackend, TuiSkillEntry } from '../lib/tui-backend.js';
import { connectRemoteDirectHost } from './connect-daemon-host.js';
import { createDaemonProviderMenu } from './daemon-tui-providers.js';
import { DaemonTuiSettingsStore } from './daemon-tui-settings-store.js';
import {
  buildLaunchParams,
  isLaunchRefusal,
  reattachDaemonTuiSession,
  resumeLaunchParams,
  type InteractiveRequest,
} from './launches/tui-launch-params.js';

const RECONNECT_BACKOFF_MS = [150, 400, 900] as const;

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function mapMcpStatusView(raw: Record<string, unknown>): McpStatusView {
  const servers = Array.isArray(raw['servers']) ? raw['servers'] : [];
  const snapshots: McpServerSnapshot[] = servers.map((entry) => {
    const item = entry as Record<string, unknown>;
    const toolCount = typeof item['toolCount'] === 'number' ? item['toolCount'] : 0;
    const tools = Array.isArray(item['tools'])
      ? (item['tools'] as McpServerSnapshot['tools'])
      : Array.from({ length: toolCount }, (_, idx) => ({
          name: `tool_${idx}`,
          description: '',
          inputSchema: {},
        }));
    return {
      name: String(item['name'] ?? item['id'] ?? ''),
      provenance: (item['provenance'] as McpServerSnapshot['provenance']) ?? 'user',
      transport: (item['transport'] as McpServerSnapshot['transport']) ?? 'stdio',
      state: (item['state'] as McpServerSnapshot['state']) ?? 'failed',
      tools,
      ...(typeof item['error'] === 'string' ? { error: item['error'] } : {}),
    };
  });
  const userConfigPath = typeof raw['userConfigPath'] === 'string' ? raw['userConfigPath'] : undefined;
  return { snapshots, ...(userConfigPath ? { userConfigPath } : {}) };
}

type OpenedDaemonTui = {
  readonly backend: TuiBackend;
  readonly initial: DirectConnection;
  readonly launched: SessionLaunchResult;
  /** The current daemon connection; reconnecting replaces it. */
  readonly rpc: () => UnixRpcClient;
};

async function openDaemonTuiSession(
  request: InteractiveRequest,
  root: string,
  onReconnected: (sessionId: string) => Promise<void>,
): Promise<OpenedDaemonTui> {
  const connect = () =>
    connectRemoteDirectHost({
      clientKind: 'tui',
      conversationsDir: request.conversationsDir,
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      env: process.env,
    });

  let connected = await connect();
  let host: RemoteDirectHost = connected.host;
  const store = new DaemonTuiSettingsStore(host);
  const skillsBySession = new Map<string, readonly TuiSkillEntry[]>();
  const modelContextWindows = new Map<string, number>();

  const loadSkillsForSession = async (sessionId: string): Promise<void> => {
    try {
      const raw = await host.listSkills({ sessionId });
      skillsBySession.set(
        sessionId,
        raw.map((item) => ({
          name: String(item['name'] ?? ''),
          description: String(item['description'] ?? ''),
          isProjectLevel: Boolean(item['isProjectLevel']),
        })),
      );
    } catch {
      if (!skillsBySession.has(sessionId)) skillsBySession.set(sessionId, []);
    }
  };

  try {
    await store.hydrateGlobal();
    const launched = await host.launchSession(buildLaunchParams(request, root));
    const initial = await host.connect(LOCAL_PRINCIPAL, launched.session.id);

    const prepareSession = async (sessionId: string): Promise<void> => {
      await Promise.all([store.hydrateSession(sessionId), loadSkillsForSession(sessionId)]);
    };
    await prepareSession(initial.sessionId);

    const providerMenu = createDaemonProviderMenu(store, () => host);

    const reconnectSession = async (
      sessionId: string,
      retained: WireSnapshot,
    ): Promise<DirectConnection | DirectReplayConnection> => {
      // Each attach is re-admitted through the launch gate with what this TUI last saw (reattachDaemonTuiSession).
      // A refusal ends the reconnect; only a failed transport moves on to a new connection.
      const last = store.liveSettings(sessionId);
      // First attempt fast re-attach on the existing Unix connection if it is still open.
      if (!host.rpc.closed) {
        const again = await reattachDaemonTuiSession(host, root, sessionId, last, retained.seq);
        if (again) {
          if (again.snapshot !== null) await prepareSession(sessionId);
          return again;
        }
      }

      let lastError: unknown;
      for (const delayMs of RECONNECT_BACKOFF_MS) {
        await waitMs(delayMs);
        try {
          const nextConnected = await connect();
          const previousHost = host;
          connected = nextConnected;
          host = nextConnected.host;
          store.replaceHost(host);
          void previousHost.dispose().catch(() => undefined);
          await store.hydrateGlobal();
          const attached = await reattachDaemonTuiSession(host, root, sessionId, last, null);
          if (!attached) throw new Error('Could not reattach to the Term2 daemon session.');
          await prepareSession(sessionId);
          // A control socket leased on the old connection was released with it.
          await onReconnected(sessionId).catch(() => undefined);
          return attached;
        } catch (error) {
          if (isLaunchRefusal(error)) throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Could not reconnect to the Term2 daemon.');
    };

    const backend: TuiBackend = {
      mode: 'daemon',
      get host() {
        return host;
      },
      principal: LOCAL_PRINCIPAL,
      persistentSettings: store.globalSettings,
      serverResolvesSkills: true,
      liveSettings: (sessionId) => store.liveSettings(sessionId),
      async resumeSession(sessionId) {
        await host.launchSession(resumeLaunchParams(request, root, sessionId));
      },
      sessionDetails: (sessionId) => {
        const meta = store.sessionMeta(sessionId);
        return {
          settings: store.liveSettings(sessionId),
          rebuilt: meta.rebuilt,
          profileId: meta.profileId,
        };
      },
      sessionAccount: (sessionId, providerId) => store.sessionMeta(sessionId).sessionAccounts[providerId],
      contextWindow(model) {
        const cached = modelContextWindows.get(`${model.provider}/${model.model}`);
        if (cached !== undefined) return cached;
        return getModelContextWindow(model.provider, model.model) ?? null;
      },
      async saveApprovalPreference(sessionId, key) {
        try {
          await store.flush();
          await store.refresh(sessionId);
          const current = store.liveSettings(sessionId)?.getDynamic(key);
          await store.updateSettings({ sessionId, persist: true, changes: [{ key, value: current }] });
          return { status: 'saved' };
        } catch (error) {
          return {
            status: 'not-persisted',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      },
      async commitSettings(sessionId, input) {
        await store.updateSettings({ sessionId, persist: input.persist, changes: input.changes });
      },
      flushSettings: () => store.flush(),
      refreshSessionSettings: (sessionId) => store.refresh(sessionId),
      async listWorkspaceSessions(workspaceRoot) {
        const sessions: Array<{
          id: string;
          title?: string;
          updatedAt?: string;
          messageCount?: number;
          model: { provider: string; model: string };
        }> = [];
        let cursor: string | undefined;
        for (let page = 0; page < 5; page += 1) {
          const res = await host.listSessionsByCwd(workspaceRoot, { limit: 100, ...(cursor ? { cursor } : {}) });
          for (const item of res.sessions) {
            sessions.push({
              id: item.id,
              ...(item.title ? { title: item.title } : {}),
              updatedAt: item.updatedAt,
              ...(item.messageCount !== undefined ? { messageCount: item.messageCount } : {}),
              model: {
                provider: item.model?.provider ?? '',
                model: item.model?.model ?? '',
              },
            });
          }
          if (!res.nextCursor) break;
          cursor = res.nextCursor;
        }
        return { sessions };
      },
      skills(_workspaceRoot, sessionId) {
        if (sessionId && skillsBySession.has(sessionId)) return skillsBySession.get(sessionId)!;
        const first = skillsBySession.values().next().value;
        return first ?? [];
      },
      prepareSession,
      reconnectSession,
      async handoff(sessionId, model, text) {
        const next = await host.handoffSession(sessionId, { ...(model ? { model } : {}), text });
        return next.id;
      },
      async goal(_sessionId, latest) {
        const goal = latest.goal;
        if (!goal) return null;
        const status: DurableGoal['status'] =
          goal.status === 'achieved' || goal.status === 'abandoned' ? goal.status : 'active';
        return {
          id: goal.id,
          outcome: goal.text,
          status,
          ...(goal.successCriteria !== undefined ? { successCriteria: goal.successCriteria } : {}),
        };
      },
      async setGoal(sessionId, input) {
        const command = {
          type: 'set_goal',
          action: input.action,
          expectedGeneration: input.expectedGeneration,
          ...(input.action === 'set' && input.goal
            ? {
                goal: {
                  text: input.goal.outcome,
                  ...(input.goal.successCriteria ? { successCriteria: input.goal.successCriteria } : {}),
                },
              }
            : {}),
        };
        const result = await host.sendCommand!(LOCAL_PRINCIPAL, sessionId, command as unknown as WireCommand);
        if (!result.ok) throw new Error(result.message);
      },
      async modelCatalog(_sessionId, provider, options) {
        const res = await host.listProviderModels({ provider, ...(options?.refresh ? { refresh: true } : {}) });
        const rawModels = Array.isArray(res['models']) ? res['models'] : [];
        const models: MenuModelInfo[] = rawModels.map((entry) => {
          const item = entry as Record<string, unknown>;
          const id = String(item['id'] ?? '');
          const ctx = typeof item['contextWindow'] === 'number' ? item['contextWindow'] : undefined;
          if (ctx !== undefined) modelContextWindows.set(`${provider}/${id}`, ctx);
          return {
            id,
            provider,
            ...(typeof item['name'] === 'string' ? { name: item['name'] } : {}),
            ...(typeof item['default_reasoning_level'] === 'string'
              ? { default_reasoning_level: item['default_reasoning_level'] }
              : {}),
            ...(ctx !== undefined ? { contextWindow: ctx } : {}),
          };
        });
        const error = typeof res['error'] === 'string' ? res['error'] : undefined;
        return { models, ...(error ? { error } : {}) };
      },
      async mcpStatus(sessionId) {
        const raw = await host.getMcpStatus({ sessionId });
        return mapMcpStatusView(raw);
      },
      async mcpLogin(_sessionId, serverId, onAuthorizationUrl) {
        const raw = await host.loginMcp(serverId, launched.workspace.workspaceId);
        const server = (raw['server'] as Record<string, unknown> | undefined) ?? raw;
        const authUrl = typeof raw['authorizationUrl'] === 'string' ? raw['authorizationUrl'] : undefined;
        if (authUrl) onAuthorizationUrl?.(authUrl);
        return {
          name: String(server['name'] ?? serverId),
          state: String(server['state'] ?? 'connected'),
        };
      },
      async workspaceFiles(sessionId) {
        const raw = await host.listSessionFiles(sessionId);
        const entries = (Array.isArray(raw['entries']) ? raw['entries'] : []) as readonly MenuPathEntry[];
        const truncated = Boolean(raw['truncated']);
        return {
          entries,
          meta: {
            lastLoadedAt: Date.now(),
            totalEntries: entries.length,
            truncated,
            truncatedByTotalLimit: truncated,
            limit: 2_000,
          },
        };
      },
      providerMenu,
      providerLabel: (providerId) => store.projection().providers.find((entry) => entry.id === providerId)?.label,
      providerIds: (sessionId) =>
        store.projection(sessionId).providers.map((entry) => ({ id: entry.id, label: entry.label })),
      providerStatus(sessionId, providerId) {
        const found = store.projection(sessionId).providers.find((entry) => entry.id === providerId);
        return found ? { hasCredentials: found.hasCredentials, isDisabled: found.isDisabled } : undefined;
      },
      async close() {
        await store.close();
        await host.dispose();
      },
    };

    void connected;
    return { backend, initial, launched, rpc: () => host.rpc };
  } catch (error) {
    await store.close().catch(() => undefined);
    await host.dispose().catch(() => undefined);
    throw error;
  }
}

export async function runDaemonTuiSession(
  request: InteractiveRequest,
  mount: (input: {
    readonly backend: TuiBackend;
    readonly root: string;
    readonly initial: DirectConnection;
    readonly unconfiguredSessionId?: string;
    readonly bridge: DirectControlBridge;
    readonly getExitCode: () => number;
    readonly setUnmount: (fn: (() => void) | null) => void;
  }) => Promise<number>,
): Promise<number> {
  const root = fs.realpathSync(process.cwd());
  const reconnected: { bridge?: DaemonControlBridge } = {};
  let unmount: (() => void) | null = null;
  let exitCode = 0;
  const onSignal = (signal: NodeJS.Signals): void => {
    exitCode = signal === 'SIGINT' ? 130 : 143;
    if (unmount) unmount();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const { backend, initial, launched, rpc } = await openDaemonTuiSession(request, root, async (sessionId) => {
    await reconnected.bridge?.reattach(sessionId);
  });
  const bridge = createDaemonControlBridge(rpc);
  reconnected.bridge = bridge;
  try {
    if (launched.forkedFrom) {
      stderr.write(
        `Forked conversation ${displaySessionId(launched.forkedFrom)} → ${displaySessionId(initial.sessionId)}\n`,
      );
    }
    if (request.resumeId !== undefined) stdout.write(`Resumed conversation: ${displaySessionId(initial.sessionId)}\n`);
    const isUnconfigured =
      request.resumeId === undefined &&
      request.selection.settings.getSource?.('agent.modelSelection') === 'default' &&
      backend.persistentSettings.getSource?.('agent.modelSelection') === 'default';
    return await mount({
      backend,
      root: launched.workspace.root,
      initial,
      unconfiguredSessionId: isUnconfigured ? initial.sessionId : undefined,
      bridge,
      getExitCode: () => exitCode,
      setUnmount: (fn) => {
        unmount = fn;
      },
    });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try {
      await bridge.close();
    } finally {
      await backend.close();
    }
  }
}
