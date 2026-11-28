/**
 * Explicit app-layer TUI backend seam (`docs/plans/daemon/zoom/tui.md`, Decision D009).
 * Both the in-process DirectApplication backend and the Client API v1.1 Unix daemon
 * backend implement this narrow interface so Ink, input ownership, slash commands,
 * menus, and terminal probes stay shared across both modes.
 */
import { collectProviderModels } from '../../model/models/model-listing.js';
import type {
  MenuModelInfo,
  MenuPathEntry,
  MenuWorkspaceEntriesMeta,
  TuiProviderMenu,
} from '../../clients/tui/integration.js';
import type {
  DirectConnection,
  DirectHost,
  DirectReplayConnection,
  Principal,
} from '../../host/in-process-direct-types.js';
import type { SettingsUpdateParamsV11 } from '../../protocol/client-api/client-api-schema.js';
import type { WireSnapshot } from '../../protocol/wire.js';
import type { DurableGoal } from '../../session/goal.js';
import type { LoggingService } from '../../session/logging/logging-service.js';
import type { ISettingsService } from '../../shared/service-interfaces.js';
import type { DirectApplication } from '../application.js';
import type { DirectMcp } from '../mcp.js';
import type { McpStatusView } from '../../tools/mcp/mcp-status.js';

type SettingsChangeV11 = SettingsUpdateParamsV11['changes'][number];
export type TuiSavedPreferenceKey =
  | 'agent.modelSelection'
  | 'sandbox.enabled'
  | 'shell.autoApproveMode'
  | 'shell.showReview';

export type TuiPreferenceSaveResult =
  | { readonly status: 'saved' }
  | { readonly status: 'not-persisted'; readonly reason: string };

export type TuiWorkspaceSessionItem = {
  readonly id: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly messageCount?: number;
  readonly model: { readonly provider: string; readonly model: string };
};

export type TuiSkillEntry = {
  readonly name: string;
  readonly description: string;
  readonly isProjectLevel: boolean;
  readonly body?: string;
};

export interface TuiBackend {
  readonly mode: 'in-process' | 'daemon';
  readonly host: DirectHost;
  readonly principal: Principal;
  readonly persistentSettings: ISettingsService;
  /** True when the daemon resolves skill bodies server-side on `preview`/`submit`. */
  readonly serverResolvesSkills?: boolean;
  liveSettings(sessionId: string): ISettingsService | null;
  sessionDetails(sessionId: string): {
    readonly settings: ISettingsService | null;
    readonly rebuilt: boolean;
    readonly profileId: string | null;
  };
  sessionAccount(sessionId: string, providerId: 'codex' | 'grok'): string | null;
  contextWindow(model: { readonly provider: string; readonly model: string }): number | null;
  saveApprovalPreference(sessionId: string, key: TuiSavedPreferenceKey): Promise<TuiPreferenceSaveResult>;
  /** Daemon-backed explicit settings commit (awaiting RPC confirmation). */
  commitSettings?(
    sessionId: string,
    input: { readonly persist: boolean; readonly changes: readonly SettingsChangeV11[] },
  ): Promise<void>;
  /** Wait for any queued daemon settings or provider writes to finish before rebuild or exit. */
  flushSettings?(): Promise<void>;
  /** Refresh a session's settings projection from the daemon after wire `configure` completes. */
  refreshSessionSettings?(sessionId: string): Promise<void>;
  listWorkspaceSessions(root: string): Promise<{ readonly sessions: readonly TuiWorkspaceSessionItem[] }>;
  skills(root: string, sessionId?: string): readonly TuiSkillEntry[];
  /** Hydrate per-session projections (settings stream, skills) before rendering a session. */
  prepareSession?(sessionId: string): Promise<void>;
  /** Reconnect to the same logical session after a dropped Unix connection or `resync_required`. */
  reconnectSession?(sessionId: string, retained: WireSnapshot): Promise<DirectConnection | DirectReplayConnection>;
  handoff(
    sessionId: string,
    model: { readonly provider: string; readonly model: string } | undefined,
    text: string,
  ): Promise<string>;
  goal(sessionId: string, latest: WireSnapshot): Promise<DurableGoal | null>;
  setGoal(
    sessionId: string,
    input: {
      readonly action: 'set' | 'achieved' | 'abandon';
      readonly goal?: DurableGoal;
      readonly expectedGeneration: number;
    },
  ): Promise<void>;
  modelCatalog(
    sessionId: string,
    provider: string,
    options?: { readonly refresh?: boolean },
  ): Promise<{ readonly models: readonly MenuModelInfo[]; readonly error?: string }>;
  mcpStatus(sessionId: string): Promise<McpStatusView>;
  mcpLogin(
    sessionId: string,
    serverId: string,
    onAuthorizationUrl?: (url: string) => void,
  ): Promise<{ readonly name: string; readonly state: string }>;
  /** Optional daemon-backed workspace file listing for `@` completion. */
  workspaceFiles?(sessionId: string): Promise<{
    readonly entries: readonly MenuPathEntry[];
    readonly meta: MenuWorkspaceEntriesMeta;
  }>;
  /** Optional daemon-backed provider menu adapter (replaces local settings-file writes). */
  readonly providerMenu?: TuiProviderMenu;
  /** Optional provider label override from daemon projection (covers custom providers). */
  providerLabel?(providerId: string): string | undefined;
  /** Optional provider ID list override from daemon projection (covers custom providers). */
  providerIds?(sessionId?: string): readonly { readonly id: string; readonly label: string }[];
  /** Optional provider credential/disabled checks from daemon projection. */
  providerStatus?(
    sessionId: string,
    providerId: string,
  ): { readonly hasCredentials: boolean; readonly isDisabled: boolean } | undefined;
  close(): Promise<void>;
}

export function createInProcessTuiBackend(options: {
  readonly app: DirectApplication;
  readonly persistentSettings: ISettingsService;
  readonly logger: LoggingService;
  readonly mcp?: DirectMcp;
}): TuiBackend {
  const { app, persistentSettings, logger, mcp } = options;
  return {
    mode: 'in-process',
    host: app.host,
    principal: app.principal,
    persistentSettings,
    liveSettings: (sessionId) => app.liveSettings(sessionId),
    sessionDetails: (sessionId) => {
      const details = app.sessionDetails(sessionId);
      return { settings: details.settings, rebuilt: details.rebuilt, profileId: details.profileId };
    },
    sessionAccount: (sessionId, providerId) => app.sessionAccount(sessionId, providerId),
    contextWindow: (model) => app.contextWindow(model),
    async saveApprovalPreference(sessionId, key) {
      return app.saveApprovalPreference(sessionId, key);
    },
    listWorkspaceSessions: (root) => app.listWorkspaceSessions(root),
    skills: (root) => app.skills(root),
    handoff: (sessionId, model, text) => app.handoff(sessionId, model, text),
    goal: async (sessionId) => (await app.goal(sessionId)) ?? null,
    async setGoal(sessionId, input) {
      if (input.action === 'set') {
        await app.setGoal(sessionId, input.goal, 'user', input.expectedGeneration);
        return;
      }
      const current = await app.goal(sessionId);
      if (!current) throw new Error('No durable goal is set. Use /goal set <outcome> first.');
      await app.setGoal(
        sessionId,
        { ...current, status: input.action === 'achieved' ? 'achieved' : 'abandoned' },
        'user',
        input.expectedGeneration,
      );
    },
    async modelCatalog(sessionId, provider) {
      const settingsService = app.liveSettings(sessionId);
      if (!settingsService) return { models: [], error: 'session settings unavailable' };
      const [group] = await collectProviderModels({ settingsService, loggingService: logger }, [provider]);
      return group ?? { models: [], error: 'provider catalog unavailable' };
    },
    async mcpStatus() {
      if (!mcp) throw new Error('MCP is not enabled for this application.');
      return mcp.status();
    },
    async mcpLogin(_sessionId, serverId, onAuthorizationUrl) {
      if (!mcp) throw new Error('MCP is not enabled for this application.');
      return await mcp.login(serverId, onAuthorizationUrl);
    },
    close: () => app.close(),
  };
}
