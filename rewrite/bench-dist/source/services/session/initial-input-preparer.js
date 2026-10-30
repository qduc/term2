import { consumeInputSurgeApproval } from '../input-surge-approval.js';
import { resolveSessionId } from './session-identity.js';
import { stripMemoryRecall } from '../../prompts/memory-recall-notice.js';
export class InitialInputPreparer {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    prepare(attempt, skipUserMessage, options) {
        if (!skipUserMessage && !attempt.addedUserMessage && !options?.replayFromHistory) {
            this.deps.record.addUserTurn(attempt.turn);
            attempt.markUserMessageAdded();
        }
        const plan = this.deps.inputPlanner.build(attempt.turn, {
            includeTurn: false,
            pendingModeNotice: this.deps.state.pendingModeNotice,
            replayFromHistory: options?.replayFromHistory,
        });
        if (plan.refusal) {
            let droppedUserMessage;
            if (attempt.addedUserMessage && this.deps.generationGuard.isCurrent(attempt.token)) {
                this.deps.record.removeLastUserMessage();
                droppedUserMessage = {
                    text: stripMemoryRecall(attempt.turn.text),
                    imageCount: attempt.turn.images?.length ?? 0,
                };
            }
            const { sourceProvider, targetProvider } = plan.refusal;
            const message = `Cannot switch this conversation from ${sourceProvider} to ${targetProvider}: native provider history ` +
                `has no verified portable coverage, so sending it would omit earlier context. Switch back to ${sourceProvider} ` +
                `to continue, or start a fresh conversation on ${targetProvider}.`;
            this.deps.logger.warn('Provider switch refused because native history is not portable', {
                eventType: 'provider_history.switch_refused',
                category: 'provider',
                phase: 'request_start',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
                sourceProvider,
                targetProvider,
            });
            return {
                kind: 'blocked',
                event: {
                    type: 'error',
                    kind: plan.refusal.kind,
                    message,
                    ...(droppedUserMessage ? { droppedUserMessage } : {}),
                },
            };
        }
        attempt.attachInput(plan);
        this.deps.inputPlanner.recordDispatchModel();
        const surgeDecision = this.deps.inputPlanner.inspectForSurge(attempt.streamInput, attempt.inputMode);
        const approvedSurge = options?.inputSurgeApproval && consumeInputSurgeApproval(options.inputSurgeApproval, attempt.submittedTurn);
        if (surgeDecision.action === 'block' && !approvedSurge) {
            let droppedUserMessage;
            if (attempt.addedUserMessage && this.deps.generationGuard.isCurrent(attempt.token)) {
                this.deps.record.removeLastUserMessage();
                droppedUserMessage = {
                    text: stripMemoryRecall(attempt.turn.text),
                    imageCount: attempt.turn.images?.length ?? 0,
                };
            }
            this.deps.logger.warn('Input surge guard blocked provider request', {
                eventType: 'input_surge.blocked',
                category: 'provider',
                phase: 'request_start',
                sessionId: resolveSessionId(this.deps.sessionId),
                traceId: this.deps.logger.getCorrelationId(),
                reason: surgeDecision.reason,
                stats: surgeDecision.stats,
                previousStats: surgeDecision.previousStats,
            });
            return {
                kind: 'blocked',
                event: {
                    type: 'error',
                    kind: 'input_surge_guard',
                    message: `${surgeDecision.reason} Request blocked to prevent runaway context growth. Try /undo or /clear, or compact the conversation history.`,
                    ...(droppedUserMessage ? { droppedUserMessage } : {}),
                },
            };
        }
        if (this.deps.state.pendingModeNotice) {
            this.deps.state.pendingModeNotice = null;
        }
        return { kind: 'ready' };
    }
}
//# sourceMappingURL=initial-input-preparer.js.map