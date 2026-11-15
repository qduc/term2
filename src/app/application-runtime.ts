import * as oauthAccounts from '../model/providers/oauth-session-account.js';
/** Assembles one Session's runtime from the real tool surface. Runs no provider and no tool. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { LocalExecutionContext } from './tool-contract.js';
import { installationVersion } from '../model/providers/fetch/logging-middleware.js';
import { BARE_PROFILE_ID } from '../config/profiles/legacy-adapter.js';
import { isDroppedProfile } from './dropped-profiles.js';
import { getProfileMetadata } from '../config/profiles/active-profile.js';
import { planProfileTransition } from './profile-transition.js';
import { RUNTIME_MODIFIABLE_SETTINGS } from '../config/settings/settings-schema.js';
import { buildEnvOverrides } from '../config/settings/settings-env.js';
import { SettingsService } from './settings-service.js';
import type { ModelRef } from '../model/index.js';
import { createProviderRegistry } from '../model/provider.js';
import type { DirectBackgroundTasks } from '../session/background.js';
import type { DirectContextCapabilities, DirectContextFactory, DirectContextPort } from '../session/capabilities.js';
import type { DirectBinding } from '../session/facade-types.js';
import type { DirectPreparedConfiguration } from '../session/configuration.js';
import type { DirectRolloverPreparer } from '../session/session-rotation.js';
import type { DirectVerificationOperations } from '../session/goal-verification.js';
import { DEFAULT_BUDGETS } from '../session/completion-verification/contracts.js';
import type { DirectConversationRuntime, DirectRuntimeContext } from '../session/store.js';
import { createToolSurface } from './tool-surface.js';
import type { DirectHookRuntime } from './application-hooks.js';
import { withSessionScope, createSessionScope, withEffortRejection, type SessionScope } from './application-models.js';
import { createNestedAuthorizer } from './application-nested.js';
import { prepareSessionRollover } from './application-rollover.js';
import { createDirectConfigMemoryBinding } from './config-memory.js';
import { borrowDirectConfigSurfaceOptions } from './config-remote.js';
import { prepareDirectConfiguration } from './config-runtime.js';
import {
  createDirectConfigSettings,
  recordDirectConfigSettings,
  type DirectAppConfiguration,
} from './config-settings.js';
import { readDirectInputPreviewConfiguration } from './input-preview.js';
import { createDirectSessionMemory, directMainMemoryEnabled } from './memory.js';
import { contextMilestones, runPolicy } from './application-policy.js';
import { createDirectVerificationOperations } from './verifier.js';
import { withGenerationGuard } from './generation-guard.js';
import { SessionSettingsService } from './settings.js';
import { createNativeSessionBrowser } from './native-session-browser.js';
import { nativeBrowserId } from './native-session-browser-store.js';
import { createLaunchConfigurationScope } from './launch-configuration.js';
import type { AgentSurface, ProfileSelection, ToolSurfaceOptions } from './tool-contract.js';

export type DirectRuntimeOptions = {
  readonly conversationsDir?: string;
  readonly selection: ProfileSelection;
  readonly profileExplicit?: boolean;
  readonly canRun: (workspace: DirectRuntimeContext['workspace']) => boolean;
  /**
   * For modes with a remote client. The tool gate reads `shell.autoApproveMode`
   * from settings, and `always` skips approval altogether, so a user's local
   * preference must not reach these sessions.
   */
  readonly approvalAlwaysAsks?: boolean;
  /** Require local shell isolation even when saved user settings disable it. */
  readonly requireSandbox?: boolean;
  /** False keeps native model/effort/profile/temperature changes out of global defaults. */
  readonly persistSessionConfiguration?: boolean;
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
  readonly sessionAccount: (providerId: string) => string | null;
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
  launching: ReturnType<typeof createLaunchConfigurationScope>['run'];
  /** Throws unless this application lets a session move from `previous` to `next`. */
  authorizeModel(next: ModelRef, previous: ModelRef): void | Promise<void>;
  /** An open session's runtime, for app-owned policy and commands. */
  get(sessionId: string): DirectRuntimeRecord | undefined;
  /** A session created during `operation` starts with this session's profile and effort, not the launch defaults. */
  inheriting<Result>(sessionId: string, operation: () => Promise<Result>): Promise<Result>;
};

export type DirectSessionSettings = SettingsService;

/** The settings a new session continues from, carried through the store's creation call. */
const continuedSettings = new AsyncLocalStorage<DirectSessionSettings>();

/** Targets of src/config/settings/ancillary-settings-migration.ts. */
const ANCILLARY_MIGRATION_TARGETS = [
  'agent.smartReasoningEffort',
  'agent.balancedReasoningEffort',
  'agent.cheapReasoningEffort',
  'agent.decisionModel',
] as const;

/**
 * Legacy's one service migrates an old key (say `agent.mentorReasoningEffort`) only when it loads the file at
 * launch, and the file it writes keeps the old key without the new one. A session reading that file again would
 * migrate a key the launch did not have and show a value legacy shows only from its next launch on.
 */
function keepLoadTimeMigrations(settings: SettingsService, launch: Pick<SettingsService, 'getDynamic'>): void {
  for (const key of ANCILLARY_MIGRATION_TARGETS) {
    const value = launch.getDynamic(key);
    if (isDeepStrictEqual(value, settings.getDynamic(key))) continue;
    if (value === undefined) settings.reset(key);
    else if (settings.isRuntimeModifiable(key)) settings.setDynamic(key, value, { persist: false });
  }
}

/**
 * A session owns its settings. `selection.settings` only supplies defaults: one
 * host runs sessions with different models and profiles, and restoring one
 * session's saved selection must not change another session's.
 */
function sessionSettings(
  { selection, profileExplicit, approvalAlwaysAsks, requireSandbox }: DirectRuntimeOptions,
  { metadata, configuration, model }: DirectRuntimeContext,
): DirectSessionSettings {
  const continued = continuedSettings.getStore();
  const defaults = continued ?? selection.settings;
  const settings = new SessionSettingsService({ env: buildEnvOverrides(), loggingService: selection.logger });
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
  keepLoadTimeMigrations(settings, defaults);
  // The latest configuration, where there is one, outranks the session's start fact.
  const stored = configuration?.profile ?? metadata?.profile;
  // A saved dropped workflow is historical data, not authority to reactivate it (#149).
  const profile = stored && !profileExplicit ? stored.id : defaults.get('app.activeProfileId');
  settings.set('app.activeProfileId', isDroppedProfile(profile) ? BARE_PROFILE_ID : profile, { persist: false });
  settings.set('agent.modelSelection', model, { persist: false });
  const reasoning =
    configuration?.intent.reasoningEffort ??
    (metadata ? metadata.reasoning ?? 'default' : defaults.get('agent.reasoningEffort'));
  settings.set('agent.reasoningEffort', reasoning, { persist: false });
  const temperature = configuration?.intent.temperature;
  if (temperature !== undefined) settings.set('agent.temperature', temperature, { persist: false });
  if (approvalAlwaysAsks) settings.set('shell.autoApproveMode', 'off', { persist: false });
  if (requireSandbox) settings.set('sandbox.enabled', true, { persist: false });
  // From here on, what legacy's one service would save is saved through the app's settings owner.
  if (selection.settings instanceof SettingsService) settings.saveThrough(selection.settings);
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

/** Each tool graph has its own check-in tools, and all of them act on this one Session. */
function bindCheckIns(surface: AgentSurface, port: DirectContextPort): void {
  surface.runtime.bindTaskCheckIn((target, policy) => port.configureTaskCheckIn(target, policy));
  surface.runtime.bindGoal(port);
}

export function createDirectRuntimes(
  options: DirectRuntimeOptions,
  hookRuntime: DirectHookRuntime | null,
): DirectRuntimes {
  const launchConfiguration = createLaunchConfigurationScope(options.authorizeModel);
  const records = new Map<string, DirectRuntimeRecord>();
  const accountRefreshes = new oauthAccounts.OAuthAccountRefreshCoordinator();
  const { logger, sessionContext } = options.selection;
  const { authorizeModel } = launchConfiguration;

  return {
    authorizeModel,
    launching: launchConfiguration.run,
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
      const sessionAccountStore = oauthAccounts.createSessionAccountStore(accountRefreshes);
      const selection = withEffortRejection(
        { settings, logger, sessionContext, sessionAccountStore },
        () => installed.bound?.port,
      );
      const providerModels = createProviderRegistry(selection);
      const trimConfig = {
        maxCharacters: settings.get('shell.maxOutputChars'),
        maxLines: settings.get('shell.maxOutputLines'),
      };
      const stopTrimUpdates = settings.onChange((key) => {
        if (key === 'shell.maxOutputChars') trimConfig.maxCharacters = settings.get('shell.maxOutputChars');
        if (key === 'shell.maxOutputLines') trimConfig.maxLines = settings.get('shell.maxOutputLines');
      });
      const suppliedSurfaceOptions = { ...options.surface(context.id), trimConfig: () => trimConfig };
      const surfaceOptions = {
        ...suppliedSurfaceOptions,
        ...(!suppliedSurfaceOptions.remote
          ? { localExecutionContext: new LocalExecutionContext(context.workspace.root) }
          : {}),
        // Legacy gives only an interactive local client a session browser (cli.tsx).
        ...(suppliedSurfaceOptions.sessionBrowser === true &&
        options.conversationsDir &&
        context.workspace.target === 'local'
          ? {
              sessionBrowserSource: createNativeSessionBrowser(
                options.conversationsDir,
                context.workspace,
                context.binding,
                // The live part: after a rollover it is the newest log, as the briefing names its predecessor.
                () => installed.bound?.port.backingSessionId ?? context.id,
              ),
            }
          : {}),
      };
      const promptMemoryEnabled = context.workspace.target === 'local' && directMainMemoryEnabled(settings);
      // The Session owns memory, so the surface must not offer it a second time. It
      // borrows SSH because the connection outlives this tool graph and this session.
      // The prompt may still describe that real native capability without source tools.
      const surface = createToolSurface(
        selection,
        borrowDirectConfigSurfaceOptions({
          ...surfaceOptions,
          affinity: { conversationKey: context.id, cacheKey: context.id },
          includeMemory: false,
          promptMemoryEnabled,
          workspace: context.workspace,
        }),
      );
      const scope = createSessionScope(sessionContext, context.id, new Date().toISOString());
      const profile = getProfileMetadata(String(settings.get('app.activeProfileId')));
      const {
        notice,
        profileName: _profileName,
        runtime,
        decideInteraction: _decide,
        reviewApproval: _review,
        ...request
      } = surface;
      let tasks: DirectBackgroundTasks | undefined;
      const initialSettings = createDirectConfigSettings(settings, {}).settings;
      const publish = (
        published: AgentSurface,
        profileId: string,
        rebuilt: boolean,
        configurationSettings: ProfileSelection['settings'],
        sessionAccount: (providerId: string) => string | null = providerModels.sessionAccount,
      ): void => {
        records.set(context.id, {
          surface: published,
          scope,
          settings,
          configurationSettings,
          sessionAccount,
          profileId,
          rebuilt,
          tasks: () => tasks,
        });
      };
      publish(surface, profile.activeProfileId, false, initialSettings);
      options.onSurface?.(surface, profile);
      const models = withGenerationGuard(
        withSessionScope(providerModels, scope, {
          conversationKey: context.id,
          cacheKey: context.id,
        }),
        selection,
      );
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
          // The bare id the session browser reads it by, as legacy names its sessions.
          previousSessionId: nativeBrowserId(bound.port.backingSessionId),
          request,
          signal,
          taskInventory: () =>
            bound.port.tasks.list().map(({ kind, taskId, status }) => ({ kind, id: taskId, status })),
          prepare: () => configure({}),
        });
      };
      const configure = async (configuration: DirectAppConfiguration): Promise<DirectPreparedConfiguration> => {
        const isLaunch = launchConfiguration.active(context.id);
        const approvalMode = launchConfiguration.approvalMode(context.id);
        const { bound } = installed;
        if (!bound) throw new Error('This session has not finished starting.');
        const generation = await prepareDirectConfiguration({
          context: installed.context,
          selection,
          scope,
          sessionAccountStore,
          surfaceOptions,
          configuration: { ...configuration, approvalMode },
          capabilities: bound.capabilities,
          memoryBinding,
          authorizeModel: (next, previous) => launchConfiguration.authorize(context.id, next, previous),
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
        const { intent, profile: nextProfile, capabilities, dispose } = generation;
        const saved = installed.context.configuration?.configuration;
        const sameModel =
          saved &&
          saved.model.provider === generation.configuration.model.provider &&
          saved.model.model === generation.configuration.model.model;
        // A graph-only refresh must retain the accepted request, even when model
        // discovery is cold or the saved temperature was deliberately absent.
        const preserve = sameModel && configuration.profileId === undefined;
        const effective = {
          ...generation.configuration,
          ...(preserve && configuration.reasoning === undefined ? { reasoning: saved.reasoning } : {}),
          ...(preserve && configuration.temperature === undefined ? { temperature: saved.temperature } : {}),
        };
        const request = { ...generation.request, reasoning: effective.reasoning, temperature: effective.temperature };
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
              context: {
                ...installed.context,
                model: effective.model,
                configuration: { configuration: effective, intent, profile: nextProfile },
              },
              settings: generation.settings,
              bound: { port: bound.port, capabilities },
            };
            generations.push(dispose);
            publish(generation.surface, nextProfile.id, true, generation.settings, generation.sessionAccount);
            queueMicrotask(() => {
              try {
                recordDirectConfigSettings(settings, intent, nextProfile.id, {
                  persist: !isLaunch && options.persistSessionConfiguration !== false,
                  approvalMode,
                });
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
        const sessionMemory = createDirectSessionMemory(
          {
            settings,
            workspace: context.workspace,
            subject: { kind: 'main' },
            offeredTools: surface.tools,
            adaptTool: (definition) => memoryBinding.adapt(surface, definition),
            onWarning: (message) => logger.warn(message),
          },
          port,
        );
        // The source prompt holds a marker; planDirectInstructions substitutes the
        // one real guidance/global context here instead of appending a duplicate.
        const capabilities: DirectContextCapabilities = {
          ...sessionMemory,
          ...(hooks ? { hooks } : {}),
          ...(verification
            ? {
                verification: {
                  operations: verification,
                  // Read at the completion boundary for a new task; the native
                  // started fact owns this value once that task has an attempt.
                  limits: {
                    get maxRepairs() {
                      return settings.get('agent.verificationMaxRepairs');
                    },
                    maxGateAttempts: DEFAULT_BUDGETS.maxGateAttempts,
                    maxVerifications: DEFAULT_BUDGETS.maxVerifications,
                  },
                },
              }
            : {}),
          verificationEnabled: () => settings.get('agent.completionVerification') !== false,
          backgroundCheckIns: () => ({
            enabled: settings.get('agent.backgroundCheckIn.enabled'),
            intervalMs: settings.get('agent.backgroundCheckIn.intervalMs'),
          }),
          // Only a client with a person behind it can answer these.
          unattended: !interactive,
          nativeToolSlots: surface.runtime.nativeToolSlots,
          modelRollover: surfaceOptions.sessionBrowser === true && surface.runtime.nativeToolSlots.sessions,
          contextMilestones: contextMilestones(settings, () => port.backingSessionId),
          warn: (message, fields) => logger.warn(message, fields),
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
          ...runPolicy(settings, context.id, context.model, providerModels.sessionAccount),
          context: contextFactory,
          authorizeNested: createNestedAuthorizer(runtime.resolveNestedAuthority),
          rollover,
          configure,
        },
        request: {
          ...request,
          // Discovery can be cold on resume. The accepted effective request is
          // authoritative; keep the saved intent in settings for later changes.
          ...(context.configuration
            ? {
                reasoning: context.configuration.configuration.reasoning,
                temperature: context.configuration.configuration.temperature,
              }
            : {}),
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
          stopTrimUpdates();
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
