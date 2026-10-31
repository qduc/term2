/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { withGenerationGuard } from './run.js';
import { createAppSettings } from './settings.js';
import { createToolSurface } from './tool-surface.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

export type DirectRuntimeOptions = {
  readonly selection: ProfileSelection;
  readonly profileExplicit?: boolean;
  /** Fixed per mode. The workspace comes from each session's own authority. */
  readonly surface: Omit<ToolSurfaceOptions, 'workspace'>;
  /** After any resumed selection is restored, so this reports what actually runs. */
  readonly onSurface?: (surface: AgentSurface, profile: ReturnType<typeof getProfileMetadata>) => void;
};

export type DirectRuntimes = {
  create(context: DirectRuntimeContext): DirectConversationRuntime;
  /** The live surface of an open session, for app-owned policy. */
  surface(sessionId: string): AgentSurface | undefined;
  scope(sessionId: string): SessionScope;
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

export function createDirectRuntimes(options: DirectRuntimeOptions): DirectRuntimes {
  const surfaces = new Map<string, AgentSurface>();
  const scopes = new Map<string, SessionScope>();
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
      const surface = createToolSurface(selection, { ...options.surface, workspace: context.workspace });
      const scope = scopeFor(context.id, new Date().toISOString());
      const profile = getProfileMetadata(String(selection.settings.get('app.activeProfileId')));
      const { notice, profileName: _profileName, runtime, decideInteraction: _decide, ...request } = surface;
      surfaces.set(context.id, surface);
      scopes.set(context.id, scope);
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
        dispose() {
          surfaces.delete(context.id);
          scopes.delete(context.id);
          return runtime.dispose?.();
        },
      };
    },
    surface: (sessionId) => surfaces.get(sessionId),
    scope: (sessionId) => scopes.get(sessionId) ?? ((operation) => operation()),
  };
}
