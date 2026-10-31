/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectVerificationOperations } from '../session/direct-goal-verification.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { loadSurface } from './agent-surface.js';
import type { DirectHookRuntime, DirectSessionHooks } from './direct-application-hooks.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { createDirectVerificationOperations } from './direct-verifier.js';
import { withGenerationGuard } from './run.js';
import { createAppSettings } from './settings.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

export type DirectRuntimeOptions = {
  readonly selection: ProfileSelection;
  readonly profileExplicit?: boolean;
  readonly canRun: (workspace: DirectRuntimeContext['workspace']) => boolean;
  /**
   * For modes with a remote client. The tool gate reads `shell.autoApproveMode`
   * from settings, and `always` skips approval altogether, so a user's local
   * preference must not reach these sessions.
   */
  readonly approvalAlwaysAsks?: boolean;
  /** Bound to one session, never to whichever session a client shows now. Its workspace comes from authority. */
  readonly surface: (sessionId: string) => Omit<ToolSurfaceOptions, 'workspace'>;
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

/** The fields past the store's type wait for Session to take them: see the composition report. */
export type DirectApplicationRuntime = DirectConversationRuntime & {
  /** Absent when completion verification is off, which the stop policy reports. */
  readonly verification?: DirectVerificationOperations;
};

export type DirectRuntimes = {
  create(context: DirectRuntimeContext): DirectApplicationRuntime;
  /** An open session's runtime, for app-owned policy and commands. */
  get(sessionId: string): DirectRuntimeRecord | undefined;
};

/**
 * A session owns its settings. `selection.settings` only supplies defaults: one
 * host runs sessions with different models and profiles, and restoring one
 * session's saved selection must not change another session's.
 */
function sessionSettings(
  { selection, profileExplicit, approvalAlwaysAsks }: DirectRuntimeOptions,
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
  if (approvalAlwaysAsks) settings.set('shell.autoApproveMode', 'off', { persist: false });
  return settings;
}

/**
 * `verifier.model` names a model on the session's provider. Empty means the
 * session's own model, as today: the request is still fresh and transcript-free,
 * and it stays on the provider this session already bills to.
 */
function verificationOperations(
  { settings }: ProfileSelection,
  models: DirectConversationRuntime['deps']['models'],
  { model, workspace }: DirectRuntimeContext,
): DirectVerificationOperations | undefined {
  if (settings.get('agent.completionVerification') === false) return undefined;
  const configured = settings.get('verifier.model');
  return createDirectVerificationOperations({
    models,
    model: configured ? { provider: model.provider, model: configured } : model,
    workspace,
  });
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
      if (context.metadata && !options.canRun(context.workspace)) {
        throw new Error('resume conversation belongs to a different workspace');
      }
      const selection = { settings: sessionSettings(options, context), logger, sessionContext };
      const surface = loadSurface(selection, { ...options.surface(context.id), workspace: context.workspace });
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
      const models = withGenerationGuard(withSessionScope(createProviderRegistry(selection), scope), selection);
      const verification = verificationOperations(selection, models, context);
      return {
        deps: {
          models,
          tools: runtime.tools,
          toolContext: runtime.toolContext,
          maxParallelToolCalls: runtime.maxParallelToolCalls,
        },
        request: { ...request, ...(notice ? { notice } : {}) },
        profile: { id: profile.activeProfileId, version: profile.activeProfileVersion, digest: profile.activeProfileDigest },
        appVersion: installationVersion,
        ...(verification ? { verification } : {}),
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
