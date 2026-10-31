/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { loadSurface } from './agent-surface.js';
import type { DirectHookRuntime, DirectSessionHooks } from './direct-application-hooks.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { withGenerationGuard } from './run.js';
import { createAppSettings } from './settings.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

export type DirectRuntimeOptions = {
  readonly selection: ProfileSelection;
  readonly profileExplicit?: boolean;
  /** Fixed per mode. The workspace comes from each session's own authority. */
  readonly surface: Omit<ToolSurfaceOptions, 'workspace'>;
  /** After any resumed selection is restored, so this reports what actually runs. */
  readonly onSurface?: (surface: AgentSurface, profile: ReturnType<typeof getProfileMetadata>) => void;
};

/** What the app holds for one open session. */
export type DirectRuntimeRecord = {
  readonly surface: AgentSurface;
  readonly scope: SessionScope;
  readonly settings: ProfileSelection['settings'];
  readonly hooks: DirectSessionHooks | null;
  readonly profileId: string;
};

export type DirectRuntimes = {
  create(context: DirectRuntimeContext): DirectConversationRuntime;
  /** An open session's runtime, for app-owned policy and commands. */
  get(sessionId: string): DirectRuntimeRecord | undefined;
};

/**
 * A session owns its settings. `selection.settings` only supplies defaults: one
 * host runs sessions with different models and profiles, and restoring one
 * session's saved selection must not change another session's.
 */
function sessionSettings(
  { selection, profileExplicit }: DirectRuntimeOptions,
  { metadata, model }: DirectRuntimeContext,
): ProfileSelection['settings'] {
  const defaults = selection.settings;
  const { service: settings } = createAppSettings({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingService: selection.logger,
  });
  const profile = metadata && !profileExplicit ? metadata.profile.id : defaults.get('app.activeProfileId');
  settings.set('app.activeProfileId', profile, { persist: false });
  settings.set('agent.modelSelection', model, { persist: false });
  const reasoning = metadata ? metadata.reasoning ?? 'default' : defaults.get('agent.reasoningEffort');
  settings.set('agent.reasoningEffort', reasoning, { persist: false });
  return settings;
}

export function createDirectRuntimes(
  options: DirectRuntimeOptions,
  hookRuntime: DirectHookRuntime | null,
): DirectRuntimes {
  const records = new Map<string, DirectRuntimeRecord>();
  const { logger, sessionContext } = options.selection;

  const scopeFor = (id: string, startedAt: string): SessionScope => {
    const context = { sessionId: id, sessionStartedAt: startedAt, promptCacheKey: id };
    return (operation) => sessionContext.runWithContext(context, operation);
  };

  return {
    create(context) {
      // Metadata records a path, so the store resolves a foreign root narrower
      // rather than refusing it. Running it would act outside this mode's admission.
      if (context.metadata && context.workspace.access !== 'read_write') {
        throw new Error('resume conversation belongs to a different workspace');
      }
      const selection = { settings: sessionSettings(options, context), logger, sessionContext };
      const surface = loadSurface(selection, { ...options.surface, workspace: context.workspace });
      const scope = scopeFor(context.id, new Date().toISOString());
      const profile = getProfileMetadata(String(selection.settings.get('app.activeProfileId')));
      const { notice, profileName: _profileName, runtime, decideInteraction: _decide, ...request } = surface;
      const hooks = hookRuntime?.session(context, selection.settings) ?? null;
      records.set(context.id, {
        surface,
        scope,
        settings: selection.settings,
        hooks,
        profileId: profile.activeProfileId,
      });
      options.onSurface?.(surface, profile);
      return {
        deps: {
          models: withGenerationGuard(withSessionScope(createProviderRegistry(selection), scope), selection),
          tools: runtime.tools,
          toolContext: runtime.toolContext,
          maxParallelToolCalls: runtime.maxParallelToolCalls,
        },
        request: { ...request, ...(notice ? { notice } : {}) },
        profile: { id: profile.activeProfileId, version: profile.activeProfileVersion, digest: profile.activeProfileDigest },
        appVersion: installationVersion,
        async dispose() {
          records.delete(context.id);
          await hooks?.end();
          await runtime.dispose?.();
        },
      };
    },
    get: (sessionId) => records.get(sessionId),
  };
}
