/** Turn state shared by the adopted foreground and its commands, with the stop, settle and queue steps they repeat. */
import type { SessionRuntimeInternals } from '../../../../source/services/session/session-composition.js';
import type { AdoptedEngine, AdoptedTurnRun } from '../../engine/adopted/index.js';

export interface TurnControl {
  /** The run that is executing now, if any. */
  active: AdoptedTurnRun | undefined;
  activePostExecuteRunId: string | undefined;
  /** Settles when the latest launched turn has been recorded. */
  completion: Promise<void>;
  /** Orders interaction decisions. */
  decisionTail: Promise<void>;
  /** Orders submissions and mutating commands. */
  serial: Promise<void>;
  /** Gate for callbacks of the current generation; replaced whenever a command stops the turn. */
  cancellation: AbortController;
  /** The first fatal mutation or persistence error; later commands reject with it. */
  poisoned: unknown;
  closing: boolean;
  /** In flight while a user interrupt runs. */
  interrupting: Promise<void> | undefined;
  settingMutation: boolean;
  releaseSettings: (() => void) | undefined;
  /**
   * Aborts the callback gate and installs a fresh one, invalidates the generation, then cancels the active run.
   * Returns the fresh gate's signal, plus a generation token captured right after invalidation when asked.
   */
  stop(): AbortSignal;
  stop(options: { captureToken: true }): { signal: AbortSignal; token: number };
  /** Invalidates the generation and cancels the active run, closing `runId` or else the active post-execute run. */
  cancelRun(runId?: string): void;
  /** Waits until decisions, the launched turn and engine admission have settled, or `signal` aborts. */
  settle(signal: AbortSignal): Promise<void>;
  /** Runs `run` after everything already queued on `serial`; later queued work waits for it. */
  queue<T>(run: () => T | PromiseLike<T>): Promise<T>;
}

export function createTurnControl(deps: { engine: AdoptedEngine; runtime: SessionRuntimeInternals }): TurnControl {
  const { engine, runtime } = deps;
  const closeAndCancel = (runId: string | undefined) => {
    if (runId) runtime.postExecutePending.closeRun(runId);
    turn.active?.cancel();
  };
  function stop(): AbortSignal;
  function stop(options: { captureToken: true }): { signal: AbortSignal; token: number };
  function stop(options?: { captureToken?: boolean }) {
    turn.cancellation.abort();
    turn.cancellation = new AbortController();
    const signal = turn.cancellation.signal;
    runtime.generationGuard.invalidate();
    const token = options?.captureToken ? runtime.generationGuard.capture() : undefined;
    closeAndCancel(turn.activePostExecuteRunId);
    return options?.captureToken ? { signal, token } : signal;
  }
  const turn: TurnControl = {
    active: undefined,
    activePostExecuteRunId: undefined,
    completion: Promise.resolve(),
    decisionTail: Promise.resolve(),
    serial: Promise.resolve(),
    cancellation: new AbortController(),
    poisoned: undefined,
    closing: false,
    interrupting: undefined,
    settingMutation: false,
    releaseSettings: undefined,
    stop,
    cancelRun(runId) {
      runtime.generationGuard.invalidate();
      closeAndCancel(runId ?? turn.activePostExecuteRunId);
    },
    async settle(signal) {
      await turn.decisionTail;
      await turn.completion;
      if (turn.active) await turn.active.waitForSettlement(signal);
      await engine.waitForAdmission(signal);
    },
    queue(run) {
      const operation = turn.serial.then(run);
      turn.serial = operation.then(
        () => undefined,
        () => undefined,
      );
      return operation;
    },
  };
  return turn;
}
