/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SessionRolloverRequest } from '../../../source/contracts/session-rollover.js';
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { getProfileMetadata } from '../../../source/services/profiles/active-profile.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import type { ModelRef } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectBackgroundTasks } from '../session/direct-background.js';
import type { DirectContextCapabilities, DirectContextFactory } from '../session/direct-capabilities.js';
import type { DirectBinding } from '../session/facade-types.js';
import type { DirectCommandConfiguration, DirectCommandOutcome } from '../session/direct-command-types.js';
import type { DirectVerificationOperations } from '../session/direct-goal-verification.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/direct-store.js';
import { loadSurface } from './agent-surface.js';
import type { DirectHookRuntime } from './direct-application-hooks.js';
import { withSessionScope, type SessionScope } from './direct-application-models.js';
import { createNestedAuthorizer } from './direct-application-nested.js';
import { createDirectConfigMemoryBinding } from './direct-config-memory.js';
import { borrowDirectConfigSurfaceOptions } from './direct-config-remote.js';
import { prepareDirectConfiguration, type DirectConfiguredGeneration } from './direct-config-runtime.js';
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
  readonly authorizeModel?: (next: ModelRef, previous: ModelRef) => void;
  /** Runs inside the Session's command reservation. */
  readonly rollover: (sessionId: string, request?: SessionRolloverRequest) => Promise<DirectCommandOutcome>;
  /** After any resumed selection is restored, so this reports what actually runs. */
  readonly onSurface?: (surface: AgentSurface, profile: ReturnType<typeof getProfileMetadata>) => void;
};

/**
 * A configured runtime the Session may still throw away: `dispose()` discards it.
 * `install()` is the Session's own last step, after the durable append and in the
 * same synchronous step as its swap, so it cannot throw. From then on the runtime
 * belongs to this session until shutdown.
 */
export type DirectPreparedConfiguration = DirectConfiguredGeneration & { install(): void };

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
  /** A session created during `operation` starts with this session's profile and effort, not the launch defaults. */
  inheriting<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result>;
};

/** The settings a new session continues from, carried through the store's creation call. */
const continuedSettings = new AsyncLocalStorage<ProfileSelection['settings']>();

/**
 * A session owns its settings. `selection.settings` only supplies defaults: one
 * host runs sessions with different models and profiles, and restoring one
 * session's saved selection must not change another session's.
 */
function sessionSettings(
  { selection, profileExplicit, approvalAlwaysAsks }: DirectRuntimeOptions,
  { metadata, model }: DirectRuntimeContext,
): ProfileSelection['settings'] {
  const defaults = continuedSettings.getStore() ?? selection.settings;
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
  if (metadata?.temperature !== undefined) settings.set('agent.temperature', metadata.temperature, { persist: false });
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
      // The Session owns memory, so the surface must not offer it a second time. It
      // borrows SSH because the connection outlives this tool graph and this session.
      const surface = loadSurface(
        selection,
        borrowDirectConfigSurfaceOptions({ ...surfaceOptions, includeMemory: false, workspace: context.workspace }),
      );
      const scope = scopeFor(context.id, new Date().toISOString());
      const profile = getProfileMetadata(String(selection.settings.get('app.activeProfileId')));
      const { notice, profileName: _profileName, runtime, decideInteraction: _decide, ...request } = surface;
      let tasks: DirectBackgroundTasks | undefined;
      const publish = (published: AgentSurface, settings: ProfileSelection['settings'], profileId: string): void => {
        records.set(context.id, { surface: published, scope, settings, profileId, tasks: () => tasks });
      };
      publish(surface, selection.settings, profile.activeProfileId);
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
        readonly selection: ProfileSelection;
        readonly capabilities?: DirectContextCapabilities;
      } = { context, selection };
      const rollover = (request?: SessionRolloverRequest) => options.rollover(context.id, request);
      const configure = async (configuration: DirectCommandConfiguration): Promise<DirectPreparedConfiguration> => {
        const { capabilities } = installed;
        if (!capabilities) throw new Error('This session has not finished starting.');
        const generation = await prepareDirectConfiguration({
          context: installed.context,
          selection: installed.selection,
          scope,
          surfaceOptions,
          configuration,
          capabilities,
          memoryBinding,
          authorizeModel: options.authorizeModel ?? sameModelOnly,
        });
        return {
          ...generation,
          // The Session replaces its whole dependency set, so its own commands must survive.
          deps: { ...generation.deps, rollover, configure },
          install() {
            installed = {
              context: { ...installed.context, model: generation.configuration.model },
              selection: { ...installed.selection, settings: generation.settings },
              capabilities: generation.capabilities,
            };
            generations.push(generation.dispose);
            publish(generation.surface, generation.settings, generation.profile.id);
            try {
              options.onSurface?.(generation.surface, getProfileMetadata(generation.profile.id));
            } catch (error) {
              logger.warn(`Could not report the new surface: ${String(error)}`);
            }
          },
        };
      };
      const contextFactory: DirectContextFactory = (port) => {
        tasks = port.tasks;
        const hooks = hookRuntime?.session(context, selection.settings);
        const capabilities: DirectContextCapabilities = {
          ...createDirectSessionMemory(
            {
              settings: selection.settings,
              workspace: context.workspace,
              subject: { kind: 'main' },
              adaptTool: (definition) => memoryBinding.adapt(surface, definition),
              onWarning: (message) => logger.warn(message),
            },
            port,
          ),
          ...(hooks ? { hooks } : {}),
          ...(verification ? { verification: { operations: verification } } : {}),
          verificationEnabled: () => selection.settings.get('agent.completionVerification') !== false,
          backgroundCheckIns: () => ({
            enabled: selection.settings.get('agent.backgroundCheckIn.enabled'),
            intervalMs: selection.settings.get('agent.backgroundCheckIn.intervalMs'),
          }),
          // Only a client with a person behind it can answer these.
          unattended: !interactive,
          proposeGoal: interactive,
        };
        installed = { ...installed, capabilities };
        return capabilities;
      };
      return {
        deps: {
          models,
          tools: runtime.tools,
          toolContext: runtime.toolContext,
          maxParallelToolCalls: runtime.maxParallelToolCalls,
          ...runPolicy(selection.settings, context.id, context.model),
          context: contextFactory,
          authorizeNested: createNestedAuthorizer(selection.settings, context.model, runtime.resolveNestedAuthority),
          rollover,
          configure,
        },
        request: {
          ...request,
          ...(notice ? { notice } : {}),
          previewMode: readDirectInputPreviewConfiguration(selection.settings, context.model).mode,
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
