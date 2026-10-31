/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { AutomaticMemoryCanary } from '../../../source/services/memory/automatic-memory-canary.js';
import { MemoryCapabilityBuilder } from '../../../source/services/memory/memory-capabilities.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectBackgroundTasks } from '../session/direct-background.js';
import type { DirectContextFactory } from '../session/direct-capabilities.js';
import type { DirectBinding } from '../session/facade-types.js';
import { createDirectAutomaticMemory } from '../session/direct-memory.js';
import type { DirectVerificationOperations } from '../session/direct-goal-verification.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { loadSurface } from './agent-surface.js';
import type { DirectHookRuntime } from './direct-application-hooks.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { runPolicy } from './direct-application-policy.js';
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
  /** Stamped on every session this application creates, and required of every one it opens. */
  readonly sessionBinding?: DirectBinding;
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
  readonly profileId: string;
  /** Set once the Session has replayed, which is before any client can reach it. */
  readonly tasks: () => DirectBackgroundTasks | undefined;
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
  // The verifier reads local git state only. Without it the stop policy blocks visibly.
  if (settings.get('agent.completionVerification') === false || workspace.target !== 'local') return undefined;
  const configured = settings.get('verifier.model');
  return createDirectVerificationOperations({
    models,
    model: configured ? { provider: model.provider, model: configured } : model,
    workspace,
  });
}

/** The opt-in canary, on the same terms as today. It never runs over SSH. */
function automaticMemory(
  settings: ProfileSelection['settings'],
  { id, workspace }: DirectRuntimeContext,
  port: Parameters<DirectContextFactory>[0],
): ReturnType<DirectContextFactory>['automaticMemory'] {
  if (process.env.TERM2_AUTOMATIC_MEMORY_CANARY !== '1' || workspace.target !== 'local') return undefined;
  if (!settings.get('memory.enabled')) return undefined;
  return createDirectAutomaticMemory({
    sessionId: id,
    canary: new AutomaticMemoryCanary(new MemoryCapabilityBuilder(settings).projectStore(workspace.root)),
    allowed: () => settings.get('memory.enabled') === true,
    readState: () => port.read().memory,
    commit: (facts) => port.commit(port.read().goal.generation, facts),
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
      // The store checks a binding that was asked for. A plain local run asks for none, so this catches it.
      if (context.binding?.client === 'ssh' && context.binding.id !== options.sessionBinding?.id) {
        throw new Error('resume conversation belongs to a different SSH workspace');
      }
      const selection = { settings: sessionSettings(options, context), logger, sessionContext };
      const surfaceOptions = options.surface(context.id);
      const surface = loadSurface(selection, { ...surfaceOptions, workspace: context.workspace });
      const scope = scopeFor(context.id, new Date().toISOString());
      const profile = getProfileMetadata(String(selection.settings.get('app.activeProfileId')));
      const { notice, profileName: _profileName, runtime, decideInteraction: _decide, ...request } = surface;
      let tasks: DirectBackgroundTasks | undefined;
      records.set(context.id, {
        surface,
        scope,
        settings: selection.settings,
        profileId: profile.activeProfileId,
        tasks: () => tasks,
      });
      options.onSurface?.(surface, profile);
      const models = withGenerationGuard(withSessionScope(createProviderRegistry(selection), scope), selection);
      const verification = verificationOperations(selection, models, context);
      const interactive = surfaceOptions.interactive === true;
      const contextFactory: DirectContextFactory = (port) => {
        tasks = port.tasks;
        const hooks = hookRuntime?.session(context, selection.settings);
        const memoryNotices = automaticMemory(selection.settings, context, port);
        return {
          ...(hooks ? { hooks } : {}),
          ...(verification ? { verification: { operations: verification } } : {}),
          ...(memoryNotices ? { automaticMemory: memoryNotices } : {}),
          verificationEnabled: () => selection.settings.get('agent.completionVerification') !== false,
          // Only a client with a person behind it can answer these.
          unattended: !interactive,
          proposeGoal: interactive,
        };
      };
      return {
        deps: {
          models,
          tools: runtime.tools,
          toolContext: runtime.toolContext,
          maxParallelToolCalls: runtime.maxParallelToolCalls,
          ...runPolicy(selection.settings, context.id, context.model),
          context: contextFactory,
        },
        request: { ...request, ...(notice ? { notice } : {}) },
        profile: {
          id: profile.activeProfileId,
          version: profile.activeProfileVersion,
          digest: profile.activeProfileDigest,
        },
        appVersion: installationVersion,
        async dispose() {
          records.delete(context.id);
          await runtime.dispose?.();
        },
      };
    },
    get: (sessionId) => records.get(sessionId),
  };
}
