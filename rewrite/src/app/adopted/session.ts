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
    try {
      assembly = createAppAdoptedEngine({
        ...synchronous(options.engine(context), 'engine options'),
        bindSessionClient(client) {
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
      const owned = assembly;
      const foreground = createAdoptedForeground({
        context,
        engine: owned.engine,
        runtime: graph,
        restored: loadCanonicalConversation(context.id, context.root),
        onSourceEvent: options.onSourceEvent,
        publishFacts: false,
        cancelBackground,
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
      let closing: Promise<void> | undefined;
      return {
        driver: foreground.driver,
        submission: foreground.submission,
        shutdown() {
          closing ??= (async () => {
            let failure: unknown;
            for (const cleanup of [() => foreground.shutdown(), () => graph.shutdown(), () => owned.engine.dispose()]) {
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
