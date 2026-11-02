import { isDeepStrictEqual } from 'node:util';
import { forkLegacySettingsBinding } from '../../engine/adopted/settings.js';
import { forkSourceModelTransports, type SourceModelTransports } from '../../engine/adopted/provider-transports.js';
import { projectRuntimeSettings } from './settings.js';
import {
  isReasoningSetting,
  isTemperatureSetting,
} from '../../../../source/services/settings/session-runtime-settings.js';
import type { AgentClient } from '../../../../source/lib/agent-client.js';
import { InvalidatableShellChildRegistry } from '../../../../source/utils/shell/shell-child-registry.js';
import { createNetworkAuthority } from './network-authority.js';
import { createScopedSandboxNetworkAccess } from '../../../../source/utils/shell/sandbox/scoped-sandbox-network-access.js';
import { ScopedSandboxRunner } from '../../../../source/utils/shell/sandbox/scoped-sandbox-runner.js';
import { createSessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import { createAdoptedForeground } from './foreground.js';
import { createGoalAuthority } from './goal-authority.js';
import { loadCanonicalConversation } from './conversation-log.js';
import type { AdoptedAdmissionContext } from './submission.js';
import type { AdoptedSessionHandle } from '../local-store.js';
import type { createAdoptedEngine, AdoptedEngine } from '../../engine/adopted/index.js';
import type { SettingsReader } from '../../config/index.js';
import type { TurnPrompt } from './turn-prompt.js';

/** Source-agent construction is supplied by the caller, never imported upward from app. */
export type LegacyEngineOptions = {
  readonly models: SourceModelTransports;
  readonly settings: SettingsReader;
  readonly clientOptions: Parameters<typeof createAdoptedEngine>[0]['clientOptions'];
  readonly bindSessionClient?: (client: AgentClient) => void;
};
export type LegacyEngineAssembly = {
  readonly engine: AdoptedEngine;
  readonly turnPrompt: () => TurnPrompt;
};

function synchronous<T>(value: T, name: string): T {
  if (
    value != null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(value).catch(() => {});
    throw new TypeError(`${name} must be synchronous`);
  }
  return value;
}

/** Construct one owned engine and source graph for each open session handle. */
export function createLegacySessionHandleFactory(options: {
  assembleEngine: (options: LegacyEngineOptions) => LegacyEngineAssembly;
  engine: (context: AdoptedAdmissionContext) => Omit<LegacyEngineOptions, 'bindSessionClient'>;
  runtime: (
    context: AdoptedAdmissionContext,
  ) => Omit<Parameters<typeof createSessionRuntimeInternals>[0], 'sessionId' | 'agentClient'>;
  onSourceEvent?: Parameters<typeof createAdoptedForeground>[0]['onSourceEvent'];
}): (context: AdoptedAdmissionContext) => Promise<AdoptedSessionHandle> {
  return async (context) => {
    let runtime: SessionRuntimeInternals | undefined;
    let assembly: LegacyEngineAssembly | undefined;
    let cancelBackground: (() => void) | undefined;
    let ownedClient: AgentClient | undefined;
    let graphModels: SourceModelTransports | undefined;
    let grantHumanRunBudgetExtension: (() => { granted: boolean; extensionsGranted: number }) | undefined;
    const scopedChildren = new InvalidatableShellChildRegistry();
    let clientForNetwork: import('../../../../source/lib/agent-client.js').AgentClient | undefined;
    let foregroundForNetwork: ReturnType<typeof createAdoptedForeground> | undefined;
    let scope: ReturnType<typeof createScopedSandboxNetworkAccess>;
    const network = createNetworkAuthority(
      context,
      () => {
        const failure = new Error('Network persistence failed');
        context.poison(failure);
        foregroundForNetwork?.failPersistence(failure);
        scopedChildren.invalidate();
        clientForNetwork?.disposeShellChildren();
        void runner.dispose();
      },
      (request, reason) => {
        scope?.cancel(request, reason);
      },
    );
    scope = createScopedSandboxNetworkAccess({
      workspaceRoot: context.state().workspace.root,
      requestApproval: network.requestApproval,
      isLive: network.isLive,
    });
    const runner = new ScopedSandboxRunner(
      scope,
      () => {
        scopedChildren.invalidate();
        void network.cancelAll('helper_lost').catch(() => {});
      },
      () => network.cancelAll('execution_ended'),
    );
    try {
      const engineOptions = synchronous(options.engine(context), 'engine options');
      const runtimeOptions = synchronous(options.runtime(context), 'runtime options');
      const hostSettings = engineOptions.clientOptions.deps.settings;
      const reason = engineOptions.clientOptions.reasoningEffort ?? hostSettings.get('agent.reasoningEffort');
      const temp = hostSettings.get('agent.temperature');
      const entries = [];
      for await (const entry of context.log.read()) entries.push(entry);
      const facts = entries.map((entry) => entry.fact);
      const goals = createGoalAuthority(entries);
      const initial = projectRuntimeSettings(facts, {
        selection: context.state().model,
        reasoningEffort: isReasoningSetting(reason) ? reason : 'default',
        ...(isTemperatureSetting(temp) ? { temperature: temp } : {}),
      });
      const binding = forkLegacySettingsBinding(engineOptions.settings, hostSettings, initial.snapshot);
      graphModels = forkSourceModelTransports(engineOptions.models, binding.service);
      assembly = synchronous(
        options.assembleEngine({
          ...engineOptions,
          models: graphModels,
          settings: binding.settings,
          clientOptions: {
            ...engineOptions.clientOptions,
            selection: initial.snapshot.selection,
            reasoningEffort: initial.snapshot.reasoningEffort,
            deps: {
              ...engineOptions.clientOptions.deps,
              settings: binding.service,
              scopedSandbox: {
                runner,
                registerPauseController: scope.registerPauseController,
                childRegistry: scopedChildren,
              },
              // Last: the session's goal authority replaces any host goal callbacks.
              ...goals.clientDeps,
            },
          },
          bindSessionClient(boundClient) {
            ownedClient = boundClient;
            const client = boundClient;
            clientForNetwork = client;
            grantHumanRunBudgetExtension = () => client.grantRunBudgetExtension();
            cancelBackground = () => {
              let failure: unknown;
              let failed = false;
              try {
                client.cancelBackgroundRuns();
              } catch (error) {
                failed = true;
                failure = error;
              }
              try {
                client.cancelBackgroundShellJobs();
              } catch (error) {
                if (!failed) failure = error;
                failed = true;
              }
              if (failed) throw failure;
            };
            runtime = createSessionRuntimeInternals({
              ...runtimeOptions,
              deps: { ...runtimeOptions.deps, settingsService: binding.service },
              sessionId: context.id,
              conversationLogRoot: context.root,
              agentClient: client,
            });
          },
        }),
        'engine assembly',
      );
      if (!runtime || !ownedClient) throw new Error('Session runtime was not bound');
      const actual = ownedClient.getRuntimeSettingsSnapshot();
      if (!isDeepStrictEqual(actual, initial.snapshot))
        throw new Error('Built client settings disagree with canonical baseline');
      if (!initial.initialized)
        await context.commit([
          ...(facts.some((f) => f.type === 'session_bound')
            ? []
            : [
                {
                  type: 'session_bound' as const,
                  version: 1 as const,
                  workspace: context.state().workspace,
                  model: actual.selection,
                },
              ]),
          {
            type: 'session_settings_initialized',
            version: 1,
            model: actual.selection,
            reasoningEffort: actual.reasoningEffort,
            ...(actual.temperature === undefined ? {} : { temperature: actual.temperature }),
          },
        ]);
      const graph = runtime;
      const originalPrepareRollover = graph.prepareRollover;
      const assertNetworkIdle = () => {
        if (network.hasPending()) throw new Error('Session rollover is blocked while a network approval is pending.');
      };
      graph.prepareRollover = (id, startedAt) => {
        assertNetworkIdle();
        const commit = originalPrepareRollover(id, startedAt);
        return () => {
          assertNetworkIdle();
          commit();
        };
      };
      graph.rollover = (id, startedAt) => graph.prepareRollover(id, startedAt)();
      const owned = assembly;
      const restored = loadCanonicalConversation(context.id, context.root);
      const foreground = createAdoptedForeground({
        context,
        engine: owned.engine,
        runtime: graph,
        restored,
        onSourceEvent: options.onSourceEvent,
        publishFacts: false,
        cancelBackground,
        reserveNetworkForCompaction: () => network.reserveForCompaction(),
        runtimeSettings: {
          supports: (command) =>
            typeof (command.kind === 'model'
              ? ownedClient!.setModelSelection
              : command.kind === 'reasoning'
              ? ownedClient!.setReasoningEffort
              : ownedClient!.setTemperature) === 'function',
          setOverride: binding.setRuntimeOverride,
          snapshot: () => ownedClient!.getRuntimeSettingsSnapshot(),
        },
        grantHumanRunBudgetExtension,
        makeInput(turnId) {
          const state = context.state();
          const prompt = owned.turnPrompt();
          return {
            turnId,
            history: [],
            newItems: [],
            instructions: prompt.instructions,
            model: state.model,
            toolNames: prompt.toolNames,
            workspace: state.workspace,
            budget: { kind: 'adopted' },
          };
        },
      });
      foregroundForNetwork = foreground;
      goals.bind({
        commit: foreground.commit,
        history: restored.history,
        isClosed: () => context.state().status === 'closed',
      });
      let closing: Promise<void> | undefined;
      let networkClosing: Promise<void> | undefined;
      const closeNetwork = () => {
        networkClosing ??= (async () => {
          let failure: unknown;
          try {
            scopedChildren.invalidate();
          } catch (error) {
            failure ??= error;
          }
          try {
            clientForNetwork?.disposeShellChildren();
          } catch (error) {
            failure ??= error;
          }
          try {
            cancelBackground?.();
          } catch (error) {
            failure ??= error;
          }
          try {
            await network.close();
          } catch (error) {
            failure ??= error;
          }
          try {
            await runner.dispose();
          } catch (error) {
            failure ??= error;
          }
          if (failure !== undefined) throw failure;
        })();
        return networkClosing;
      };
      return {
        driver: foreground.driver,
        submission: { ...foreground.submission, networkApproval: network, goal: goals.control },
        closeNetwork,
        shutdown() {
          closing ??= (async () => {
            let failure: unknown;
            for (const cleanup of [
              () => closeNetwork(),
              () => foreground.shutdown(),
              () => graph.shutdown(),
              () => owned.engine.dispose(),
              () => graphModels!.dispose(),
            ]) {
              try {
                await cleanup();
              } catch (error) {
                failure ??= error;
              }
            }
            graph.record.setJournalSink(null);
            graph.conversationLogger.setLogSink(null);
            if (failure !== undefined) throw failure;
          })();
          return closing;
        },
      };
    } catch (error) {
      try {
        await network.close();
        await runner.dispose();
      } catch {
        /* Preserve construction error. */
      }
      try {
        await runtime?.shutdown();
      } catch {
        /* Preserve the construction error. */
      }
      try {
        await assembly?.engine.dispose();
      } catch {
        /* Preserve the construction error. */
      }
      try {
        await graphModels?.dispose();
      } catch {
        /* Preserve construction error. */
      }
      throw error;
    }
  };
}
