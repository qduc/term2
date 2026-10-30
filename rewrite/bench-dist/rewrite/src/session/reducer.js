import { normalizedModelSelection } from './adopted/settings.js';
import { projectRetryEligibility } from './adopted/conversation-retry-projection.js';
export function initialState(id, workspace, model) {
    return {
        id,
        status: 'idle',
        workspace,
        model,
        history: [],
        providerHistory: [],
        messages: [],
        activeTurnId: null,
        pendingInteraction: null,
        queue: [],
        admissions: {},
        retryEligibility: { turn: false, tool: false },
        canRetry: false,
        binding: null,
        closedAt: null,
        lastSeq: 0,
    };
}
/** Applies only fact-owned lifecycle projection; transcript replay remains adopted from source. */
export const projectLifecycle = (state, entry) => {
    const fact = entry.fact;
    const next = { ...state, lastSeq: entry.seq };
    if (state.status === 'closed' && fact.type !== 'session_closed')
        return next;
    switch (fact.type) {
        case 'session_settings_initialized':
            return { ...next, model: fact.model };
        case 'settings_changed':
            if (fact.key === 'agent.modelSelection') {
                const model = normalizedModelSelection(fact.value);
                if (model)
                    return { ...next, model };
            }
            if (fact.key === 'agent.model' && typeof fact.value === 'string')
                return { ...next, model: { ...state.model, model: fact.value } };
            if (fact.key === 'agent.provider' && typeof fact.value === 'string')
                return { ...next, model: { ...state.model, provider: fact.value } };
            return next;
        case 'session_bound':
            return { ...next, workspace: fact.workspace, model: fact.model, binding: fact.binding ?? null };
        case 'session_admitted': {
            const record = {
                clientRequestId: fact.clientRequestId,
                normalizedBodyHash: fact.normalizedBodyHash,
                turnId: fact.turnId,
                disposition: fact.disposition,
                createdAt: fact.createdAt,
                expiresAt: fact.expiresAt,
            };
            const admissions = { ...state.admissions, [fact.clientRequestId]: record };
            return {
                ...next,
                admissions,
                queue: fact.disposition === 'queued'
                    ? [...state.queue.filter((item) => item.clientRequestId !== record.clientRequestId), record]
                    : state.queue,
            };
        }
        case 'session_admission_settled': {
            const prior = state.admissions[fact.clientRequestId];
            if (!prior || prior.turnId !== fact.turnId)
                return next;
            const record = { ...prior, result: fact.result };
            return {
                ...next,
                admissions: { ...state.admissions, [fact.clientRequestId]: record },
                queue: state.queue.filter((item) => item.clientRequestId !== record.clientRequestId),
            };
        }
        case 'session_turn_started': {
            const queue = fact.clientRequestId === null
                ? state.queue
                : state.queue.filter((item) => item.clientRequestId !== fact.clientRequestId);
            return {
                ...next,
                status: 'running',
                activeTurnId: fact.turnId,
                pendingInteraction: null,
                queue,
                canRetry: false,
            };
        }
        case 'session_interaction_pending':
            if (state.activeTurnId && state.activeTurnId !== fact.turnId)
                return next;
            return {
                ...next,
                status: 'awaiting_interaction',
                activeTurnId: fact.turnId,
                pendingInteraction: {
                    turnId: fact.turnId,
                    interaction: fact.interaction,
                    generation: fact.generation,
                },
            };
        case 'session_interaction_resolved': {
            const pending = state.pendingInteraction;
            if (!pending ||
                pending.turnId !== fact.turnId ||
                pending.interaction.interactionId !== fact.interactionId ||
                pending.interaction.revision !== fact.revision ||
                pending.generation !== fact.generation)
                return next;
            return {
                ...next,
                status: fact.outcome === 'answered' && state.activeTurnId === fact.turnId ? 'running' : state.status,
                pendingInteraction: null,
            };
        }
        case 'session_turn_ended':
            if (state.activeTurnId !== fact.turnId)
                return next;
            return { ...next, status: 'idle', activeTurnId: null, pendingInteraction: null };
        case 'session_interrupted':
            if (fact.turnId !== null && state.activeTurnId !== fact.turnId)
                return next;
            return { ...next, status: 'interrupted', activeTurnId: null, pendingInteraction: null };
        case 'session_closed':
            return {
                ...next,
                status: 'closed',
                activeTurnId: null,
                pendingInteraction: null,
                queue: [],
                retryEligibility: { turn: false, tool: false },
                canRetry: false,
                closedAt: fact.closedAt,
            };
        default:
            return next;
    }
};
export function withTranscript(state, transcript, compatibilityItems) {
    const retryEligibility = projectRetryEligibility(transcript.history);
    const available = state.status === 'closed' ? { turn: false, tool: false } : retryEligibility;
    return {
        ...state,
        retryEligibility: available,
        canRetry: available.turn,
        history: compatibilityItems,
        providerHistory: transcript.history,
        messages: transcript.messages,
    };
}
export function newestAdmission(state, requestId, now) {
    const record = state.admissions[requestId];
    return record && Date.parse(record.expiresAt) > now ? record : null;
}
/** Old CLI logs use source replay's actual unsettled-turn audit. */
export function statusFromLegacyAudit(state, outcome) {
    if (state.lastSeq === 0 || state.activeTurnId || state.status === 'closed')
        return state;
    return {
        ...state,
        status: outcome === 'empty' || outcome === 'settled' ? 'idle' : 'interrupted',
    };
}
//# sourceMappingURL=reducer.js.map