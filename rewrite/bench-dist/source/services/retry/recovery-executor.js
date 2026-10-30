/** Applies policy-selected retry settings; Record owns acceptance and reconstruction. */
export class DefaultRecoveryExecutor {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    apply(input) {
        const { plan, state, retryCounts, maxModelRetries } = input;
        this.deps.providerContinuity.clear();
        const recoverySummary = this.deps.record.recover(plan, state);
        switch (plan.kind) {
            case 'replay_turn': {
                const instruction = {
                    skipUserMessage: !plan.rollbackUserMessage,
                    retryCounts,
                    maxModelRetries,
                };
                return { kind: 'run', instruction, events: [] };
            }
            case 'retry_fresh': {
                const instruction = {
                    skipUserMessage: true,
                    retryCounts,
                    maxModelRetries,
                    ...(plan.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
                };
                return {
                    kind: 'run',
                    instruction,
                    ...(plan.useStandardServiceTier ? { useStandardServiceTier: true } : {}),
                    ...(plan.disableChainingForAttempt ? { disableChainingForAttempt: true } : {}),
                    events: [],
                };
            }
            case 'terminate': {
                const events = recoverySummary
                    ? [
                        {
                            type: 'tool_recovery',
                            recoveredCallIds: recoverySummary.recoveredCallIds,
                            droppedCallIds: recoverySummary.droppedCallIds,
                            message: recoverySummary.message,
                        },
                    ]
                    : [];
                return { kind: 'terminated', events: [...plan.events, ...events] };
            }
        }
    }
}
//# sourceMappingURL=recovery-executor.js.map