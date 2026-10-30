export function createTurnControl(deps) {
    const { engine, runtime } = deps;
    const closeAndCancel = (runId) => {
        if (runId)
            runtime.postExecutePending.closeRun(runId);
        turn.active?.cancel();
    };
    function stop(options) {
        turn.cancellation.abort();
        turn.cancellation = new AbortController();
        const signal = turn.cancellation.signal;
        runtime.generationGuard.invalidate();
        const token = options?.captureToken ? runtime.generationGuard.capture() : undefined;
        closeAndCancel(turn.activePostExecuteRunId);
        return options?.captureToken ? { signal, token } : signal;
    }
    const turn = {
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
            if (turn.active)
                await turn.active.waitForSettlement(signal);
            await engine.waitForAdmission(signal);
        },
        queue(run) {
            const operation = turn.serial.then(run);
            turn.serial = operation.then(() => undefined, () => undefined);
            return operation;
        },
    };
    return turn;
}
//# sourceMappingURL=turn-control.js.map