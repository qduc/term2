/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { planProfileTransition } from '../../../source/services/profiles/profile-transition.js';
import { RUNTIME_MODIFIABLE_SETTINGS } from '../../../source/services/settings/settings-schema.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import type { ModelRef } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectBackgroundTasks } from '../session/direct-background.js';
import type {
  DirectContextCapabilities,
  DirectContextFactory,
  DirectContextPort,
} from '../session/direct-capabilities.js';
import type { DirectBinding } from '../session/facade-types.js';
import type { DirectPreparedConfiguration } from '../session/direct-configuration.js';
import type { DirectRolloverPreparer } from '../session/direct-session-rotation.js';
import type { DirectVerificationOperations } from '../session/direct-goal-verification.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { loadSurface } from './agent-surface.js';
import type { DirectHookRuntime } from './direct-application-hooks.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { createNestedAuthorizer } from './direct-application-nested.js';
import { prepareSessionRollover } from './direct-application-rollover.js';
import { createDirectConfigMemoryBinding } from './direct-config-memory.js';
import { borrowDirectConfigSurfaceOptions } from './direct-config-remote.js';
import { prepareDirectConfiguration } from './direct-config-runtime.js';
import { createDirectConfigSettings, type DirectAppConfiguration } from './direct-config-settings.js';
import { readDirectInputPreviewConfiguration } from './direct-input-preview.js';
import { createDirectSessionMemory } from './direct-memory.js';
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
  /** Decides whether a session may move to another model. Without it, none may. */
  readonly authorizeModel?: (next: ModelRef, previous: ModelRef) => void | Promise<void>;
  /** After any resumed selection is restored, so this reports what actually runs. */
  readonly onSurface?: (surface: AgentSurface, profile: ReturnType<typeof getProfileMetadata>) => void;
};

/** What the app holds for one open session. */
export type DirectRuntimeRecord = {
  readonly surface: AgentSurface;
  readonly scope: SessionScope;
  /** The session's own settings, and the one place a change is written. */
  readonly settings: DirectSessionSettings;
  /** Accepted immutable selection, never the TUI's pending mutable settings. */
  readonly configurationSettings: ProfileSelection['settings'];
  readonly profileId: string;
  /** Its tools read a copy of `settings`, so a change needs a rebuild to reach them. */
  readonly rebuilt: boolean;
  /** Set once the Session has replayed, which is before any client can reach it. */
  readonly tasks: () => DirectBackgroundTasks | undefined;
};

export type DirectRuntimes = {
  create(context: DirectRuntimeContext): DirectConversationRuntime;
  /** Throws unless this application lets a session move from `previous` to `next`. */
  authorizeModel(next: ModelRef, previous: ModelRef): void | Promise<void>;
  /** An open session's runtime, for app-owned policy and commands. */
  get(sessionId: string): DirectRuntimeRecord | undefined;
  /** A session created during `operation` starts with this session's profile and effort, not the launch defaults. */
  inheriting<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result>;
};

export type DirectSessionSettings = ReturnType<typeof createAppSettings>['service'];

/** The settings a new session continues from, carried through the store's creation call. */
const continuedSettings = new AsyncLocalStorage<DirectSessionSettings>();

/**
 * A session owns its settings. `selection.settings` only supplies defaults: one
 * host runs sessions with different models and profiles, and restoring one
 * session's saved selection must not change another session's.
 */
function sessionSettings(
  { selection, profileExplicit, approvalAlwaysAsks }: DirectRuntimeOptions,
  { metadata, configuration, model }: DirectRuntimeContext,
): DirectSessionSettings {
  const continued = continuedSettings.getStore();
  const defaults = continued ?? selection.settings;
  const { service: settings } = createAppSettings({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingService: selection.logger,
  });
  // `/clear` must not undo what someone changed, least of all a tightened approval
  // mode. Only real differences: rewriting a default would change what it means.
  if (continued) {
    for (const key of RUNTIME_MODIFIABLE_SETTINGS) {
      const value = continued.getDynamic(key);
      if (value !== undefined && !isDeepStrictEqual(value, settings.getDynamic(key))) {
        settings.setDynamic(key, value, { persist: false });
      }
    }
  }
  // The latest configuration, where there is one, outranks the session's start fact.
  const stored = configuration?.profile ?? metadata?.profile;
  const profile = stored && !profileExplicit ? stored.id : defaults.get('app.activeProfileId');
  settings.set('app.activeProfileId', profile, { persist: false });
  settings.set('agent.modelSelection', model, { persist: false });
  const reasoning =
    configuration?.intent.reasoningEffort ??
    (metadata ? metadata.reasoning ?? 'default' : defaults.get('agent.reasoningEffort'));
  settings.set('agent.reasoningEffort', reasoning, { persist: false });
  const temperature = configuration?.intent.temperature;
  if (temperature !== undefined) settings.set('agent.temperature', temperature, { persist: false });
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

/** Effort and temperature are a session's own to tune. The model decides who gets billed. */
function sameModelOnly(next: ModelRef, previous: ModelRef): void {
  if (next.provider === previous.provider && next.model === previous.model) return;
  throw new Error('This client may not move the session to another model.');
}

/** Each tool graph has its own check-in tools, and all of them act on this one Session. */
function bindCheckIns(surface: AgentSurface, port: DirectContextPort): void {
  surface.runtime.bindTaskCheckIn((target, policy) => port.configureTaskCheckIn(target, policy));
}

export function createDirectRuntimes(
  options: DirectRuntimeOptions,
  hookRuntime: DirectHookRuntime | null,
): DirectRuntimes {
  const records = new Map<string, DirectRuntimeRecord>();
  const { logger, sessionContext } = options.selection;
  const authorizeModel = options.authorizeModel ?? sameModelOnly;

  const scopeFor = (id: string, startedAt: string): SessionScope => {
    const context = { sessionId: id, sessionStartedAt: startedAt, promptCacheKey: id };
    return (operation) => sessionContext.runWithContext(context, operation);
  };

  return {
    authorizeModel,
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
      const settings = sessionSettings(options, context);
      const selection = { settings, logger, sessionContext };
      const surfaceOptions = options.surface(context.id);
      // The Session owns memory, so the surface must not offer it a second time. It
      // borrows SSH because the connection outlives this tool graph and this session.
      const surface = loadSurface(
        selection,
        borrowDirectConfigSurfaceOptions({ ...surfaceOptions, includeMemory: false, workspace: context.workspace }),
      );
      const scope = scopeFor(context.id, new Date().toISOString());
      const profile = getProfileMetadata(String(settings.get('app.activeProfileId')));
      const { notice, profileName: _profileName, runtime, decideInteraction: _decide, ...request } = surface;
      let tasks: DirectBackgroundTasks | undefined;
      const initialSettings = createDirectConfigSettings(settings, {}).settings;
      const publish = (
        published: AgentSurface,
        profileId: string,
        rebuilt: boolean,
        configurationSettings: ProfileSelection['settings'],
      ): void => {
        records.set(context.id, {
          surface: published,
          scope,
          settings,
          configurationSettings,
          profileId,
          rebuilt,
          tasks: () => tasks,
        });
      };
      publish(surface, profile.activeProfileId, false, initialSettings);
      options.onSurface?.(surface, profile);
      const models = withGenerationGuard(withSessionScope(createProviderRegistry(selection), scope), selection);
      const verification = verificationOperations(selection, models, context);
      const interactive = surfaceOptions.interactive === true;
      const memoryBinding = createDirectConfigMemoryBinding();
      // Background work may still hold an older graph, and these hold only local
      // listeners and policies, so each stays until the session shuts down.
      const generations: (() => void | Promise<void>)[] = [() => runtime.dispose?.()];
      let installed: {
        readonly context: DirectRuntimeContext;
        // TUI selection settings may already name a requested but unaccepted profile.
        readonly settings: ProfileSelection['settings'];
        readonly bound?: { readonly port: DirectContextPort; readonly capabilities: DirectContextCapabilities };
      } = { context, settings: initialSettings };
      const rollover: DirectRolloverPreparer = (request, signal) => {
        const { bound } = installed;
        if (!bound) throw new Error('This session has not finished starting.');
        return prepareSessionRollover({
          previousSessionId: bound.port.backingSessionId,
          request,
          signal,
          taskInventory: () =>
            bound.port.tasks.list().map(({ kind, taskId, status }) => ({ kind, id: taskId, status })),
          prepare: () => configure({}),
        });
      };
      const configure = async (configuration: DirectAppConfiguration): Promise<DirectPreparedConfiguration> => {
        const { bound } = installed;
        if (!bound) throw new Error('This session has not finished starting.');
        const generation = await prepareDirectConfiguration({
          context: installed.context,
          selection,
          scope,
          surfaceOptions,
          configuration,
          capabilities: bound.capabilities,
          memoryBinding,
          authorizeModel,
        });
        let profileTransitionNotice: string | undefined;
        try {
          bindCheckIns(generation.surface, bound.port);
          profileTransitionNotice =
            planProfileTransition(installed.settings, generation.profile.id).composedNotice ?? undefined;
        } catch (error) {
          await generation.dispose();
          throw error;
        }
        const { configuration: effective, intent, profile: nextProfile, request, capabilities, dispose } = generation;
        return {
          configuration: effective,
          intent,
          profile: nextProfile,
          ...(profileTransitionNotice ? { profileTransitionNotice } : {}),
          request,
          capabilities,
          dispose,
          // The Session replaces its whole dependency set, so its own commands must survive.
          deps: { ...generation.deps, rollover, configure },
          // The Session's atomic step: it poisons itself if this throws, so this only moves
          // pointers. Anything that can throw or reach a listener runs just after, and
          // before the command's result can reach anyone.
          install() {
            installed = {
              context: { ...installed.context, model: effective.model },
              settings: generation.settings,
              bound: { port: bound.port, capabilities },
            };
            generations.push(dispose);
            publish(generation.surface, nextProfile.id, true, generation.settings);
            queueMicrotask(() => {
              try {
                // Generations are read-only copies, so the next one has to start from this.
                settings.set('app.activeProfileId', nextProfile.id, { persist: false });
                settings.set('agent.modelSelection', intent.modelSelection, { persist: false });
                settings.set('agent.reasoningEffort', intent.reasoningEffort, { persist: false });
                if (intent.temperature !== undefined) {
                  settings.set('agent.temperature', intent.temperature, { persist: false });
                }
                options.onSurface?.(generation.surface, getProfileMetadata(nextProfile.id));
              } catch (error) {
                logger.warn(`Could not record the new configuration: ${String(error)}`);
              }
            });
          },
        };
      };
      const contextFactory: DirectContextFactory = (port) => {
        tasks = port.tasks;
        bindCheckIns(surface, port);
        const hooks = hookRuntime?.session(context, settings);
        const capabilities: DirectContextCapabilities = {
          ...createDirectSessionMemory(
            {
              settings,
              workspace: context.workspace,
              subject: { kind: 'main' },
              offeredTools: surface.tools,
              adaptTool: (definition) => memoryBinding.adapt(surface, definition),
              onWarning: (message) => logger.warn(message),
            },
            port,
          ),
          ...(hooks ? { hooks } : {}),
          ...(verification ? { verification: { operations: verification } } : {}),
          verificationEnabled: () => settings.get('agent.completionVerification') !== false,
          backgroundCheckIns: () => ({
            enabled: settings.get('agent.backgroundCheckIn.enabled'),
            intervalMs: settings.get('agent.backgroundCheckIn.intervalMs'),
          }),
          // Only a client with a person behind it can answer these.
          unattended: !interactive,
          proposeGoal: interactive,
          nativeToolSlots: surface.runtime.nativeToolSlots,
          modelRollover: surfaceOptions.sessionBrowser === true && surface.runtime.nativeToolSlots.sessions,
        };
        installed = { ...installed, bound: { port, capabilities } };
        return capabilities;
      };
      return {
        deps: {
          models,
          tools: runtime.tools,
          toolContext: runtime.toolContext,
          maxParallelToolCalls: runtime.maxParallelToolCalls,
          ...runPolicy(settings, context.id, context.model),
          context: contextFactory,
          authorizeNested: createNestedAuthorizer(settings, context.model, runtime.resolveNestedAuthority),
          rollover,
          configure,
        },
        request: {
          ...request,
          ...(notice ? { notice } : {}),
          previewMode: readDirectInputPreviewConfiguration(settings, context.model).mode,
        },
        profile: {
          id: profile.activeProfileId,
          version: profile.activeProfileVersion,
          digest: profile.activeProfileDigest,
        },
        appVersion: installationVersion,
        async dispose() {
          records.delete(context.id);
          const results = await Promise.allSettled(generations.map(async (dispose) => dispose()));
          const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
          if (failures.length) throw new AggregateError(failures, 'A tool graph could not be released.');
        },
      };
    },
    get: (sessionId) => records.get(sessionId),
    inheriting(sessionId, operation) {
      const source = records.get(sessionId)?.settings;
      return source ? continuedSettings.run(source, operation) : operation();
    },
  };
}
