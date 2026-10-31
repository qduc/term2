/**
 * Public hooks on the direct host. Discovery and the runner are the existing
 * ones. This observes accepted facts from outside the Session, so it adds no
 * writer and a hook can never change what a turn does.
 */
import { createRootHookRuntime } from '../../../source/services/hooks/hook-composition.js';
import type { Term2SessionMode, Term2Status, Term2StatusChangeReason } from '../../../source/services/hooks/hook-contracts.js';
import { createDirectHooks } from '../session/direct-hooks.js';
import type { DirectSession, DirectSessionState } from '../session/facade-types.js';
import { LOG_FORMAT_VERSION } from '../session/facts.js';
import type { DirectRuntimeContext } from '../session/direct-store.js';
import type { ProfileSelection } from './tool-contract.js';

export type DirectHookOptions = { readonly root: string; readonly mode: Term2SessionMode };

export type DirectSessionHooks = {
  /** Starts the session's hooks and follows its live facts. Safe to call for every attach. */
  observe(session: DirectSession): Promise<void>;
  /** Waits for hooks already in flight, then ends. Only the Session's real end calls this. */
  end(): Promise<void>;
};

export type DirectHookRuntime = {
  session(context: DirectRuntimeContext, settings: ProfileSelection['settings']): DirectSessionHooks;
  close(): Promise<void>;
};

function statusOf(state: DirectSessionState): Term2Status {
  if (state.status === 'running') return 'working';
  if (state.status !== 'awaiting_interaction') return 'idle';
  return state.pendingInteractions[0]?.kind === 'question' ? 'waiting_for_user' : 'waiting_for_approval';
}

function reasonFor(previous: Term2Status, state: DirectSessionState): Term2StatusChangeReason {
  const current = statusOf(state);
  if (current === 'waiting_for_approval') return 'approval_requested';
  if (current === 'waiting_for_user') return 'ask_user';
  if (current === 'idle') return state.terminal?.outcome === 'completed' ? 'turn_finished' : 'turn_failed';
  return previous === 'waiting_for_approval' ? 'approval_resolved' : 'turn_started';
}

export async function startDirectHooks(
  { root, mode }: DirectHookOptions,
  { settings, logger }: ProfileSelection,
): Promise<DirectHookRuntime> {
  const { cwd, hookService } = createRootHookRuntime({
    executionContext: { getCwd: () => root, isRemote: () => false },
    userEnabled: settings.getDynamic('hooks.user.enabled') !== false,
    projectEnabled: settings.getDynamic('hooks.project.enabled') !== false,
    trustedProjectRoots: (settings.getDynamic('hooks.trustedProjectRoots') as string[] | undefined) ?? [],
    registryOptions: { callbackTimeoutMs: Number(settings.getDynamic('hooks.timeoutMs') ?? 5_000) },
    logger(diagnostic) {
      logger.warn('Public hook diagnostic', {
        eventType: `hooks.${diagnostic.code}`,
        category: 'application',
        ...diagnostic,
      });
    },
  });
  await hookService.initialize();

  return {
    session(context, sessionSettings) {
      const hooks = createDirectHooks({
        sessionId: context.id,
        cwd,
        mode,
        model: context.model,
        lifecycle: hookService,
        includeUserText: sessionSettings.getDynamic('hooks.includeUserText') === true,
        includeToolArguments: sessionSettings.getDynamic('hooks.includeToolArguments') === true,
        includeToolResults: sessionSettings.getDynamic('hooks.includeToolResults') === true,
        diagnostic: (message, error) => logger.warn(message, { error: String(error) }),
      });
      let observing = false;
      // Hooks run in commit order, and one slow callback never holds up publication.
      let delivered: Promise<void> = Promise.resolve();
      const deliver = (operation: () => Promise<void>): void => {
        delivered = delivered.then(operation);
      };
      return {
        async observe(session) {
          if (observing) return;
          observing = true;
          let previous: Term2Status = 'idle';
          const { state } = session.capture((update) => {
            if (update.type === 'fact') {
              const line = { v: LOG_FORMAT_VERSION, seq: update.seq, at: new Date().toISOString(), fact: update.fact };
              deliver(() => hooks.accepted(line));
            }
            if (update.type === 'state') {
              const current = statusOf(update.state);
              if (current === previous) return;
              const from = previous;
              previous = current;
              const reason = reasonFor(from, update.state);
              deliver(() => hooks.status(from, current, reason, update.state.activeTurnId ?? undefined));
            }
          });
          previous = statusOf(state);
          deliver(() => hooks.start());
          await delivered;
        },
        async end() {
          await delivered;
          await hooks.end();
        },
      };
    },
    close: () => hookService.shutdown(),
  };
}
