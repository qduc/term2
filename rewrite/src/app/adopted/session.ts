import { InvalidatableShellChildRegistry } from '../../../../source/utils/shell/shell-child-registry.js';
import { createNetworkAuthority } from '../../session/adopted/network-authority.js';
import { createScopedSandboxNetworkAccess } from '../../../../source/utils/shell/sandbox/scoped-sandbox-network-access.js';
import { ScopedSandboxRunner } from '../../../../source/utils/shell/sandbox/scoped-sandbox-runner.js';
import { createSessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import { createAdoptedForeground } from '../../session/adopted/foreground.js';
import { loadCanonicalConversation } from '../../session/adopted/conversation-log.js';
import type { AdoptedAdmissionContext } from '../../session/adopted/submission.js';
import type { AdoptedSessionHandle } from '../../session/local-store.js';
import { createAppAdoptedEngine } from './engine.js';

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
export function createAppAdoptedSessionHandleFactory(options: {
  engine: (context: AdoptedAdmissionContext) => Omit<Parameters<typeof createAppAdoptedEngine>[0], 'bindSessionClient'>;
  runtime: (
    context: AdoptedAdmissionContext,
  ) => Omit<Parameters<typeof createSessionRuntimeInternals>[0], 'sessionId' | 'agentClient'>;
  onSourceEvent?: Parameters<typeof createAdoptedForeground>[0]['onSourceEvent'];
}): (context: AdoptedAdmissionContext) => Promise<AdoptedSessionHandle> {
  return async (context) => {
    let runtime: SessionRuntimeInternals | undefined;
    let assembly: ReturnType<typeof createAppAdoptedEngine> | undefined;
    let cancelBackground: (() => void) | undefined;
    const scopedChildren = new InvalidatableShellChildRegistry();
    let clientForNetwork: import('../../../../source/lib/agent-client.js').AgentClient | undefined;
    let foregroundForNetwork: ReturnType<typeof createAdoptedForeground> | undefined;
    let scope: ReturnType<typeof createScopedSandboxNetworkAccess>;
    const network = createNetworkAuthority(
      context,
      () => {
        foregroundForNetwork?.failPersistence(new Error('Network persistence failed'));
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
    let grantHumanRunBudgetExtension: (() => { granted: boolean; extensionsGranted: number }) | undefined;
    try {
      const engineOptions = synchronous(options.engine(context), 'engine options');
      assembly = createAppAdoptedEngine({
        ...engineOptions,
        clientOptions: {
          ...engineOptions.clientOptions,
          deps: {
            ...engineOptions.clientOptions.deps,
            scopedSandbox: {
              runner,
              registerPauseController: scope.registerPauseController,
              childRegistry: scopedChildren,
            },
          },
        },
        bindSessionClient(client) {
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
            ...synchronous(options.runtime(context), 'runtime options'),
            sessionId: context.id,
            agentClient: client,
          });
        },
      });
      if (!runtime) throw new Error('Session runtime was not bound');
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
      const foreground = createAdoptedForeground({
        context,
        engine: owned.engine,
        runtime: graph,
        restored: loadCanonicalConversation(context.id, context.root),
        onSourceEvent: options.onSourceEvent,
        publishFacts: false,
        cancelBackground,
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
        submission: { ...foreground.submission, networkApproval: network },
        closeNetwork,
        shutdown() {
          closing ??= (async () => {
            let failure: unknown;
            for (const cleanup of [
              () => closeNetwork(),
              () => foreground.shutdown(),
              () => graph.shutdown(),
              () => owned.engine.dispose(),
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
      throw error;
    }
  };
}
