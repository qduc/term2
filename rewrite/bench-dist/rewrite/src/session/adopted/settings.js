import { ModelSelectionSchema } from '../../../../source/services/settings/model-selection.js';
import { isReasoningSetting, isTemperatureSetting, } from '../../../../source/services/settings/session-runtime-settings.js';
export function normalizedModelSelection(value) {
    const result = ModelSelectionSchema.safeParse(value);
    return result.success ? result.data : undefined;
}
/** Derive the graph's settings from canonical facts before constructing the client. */
export function projectRuntimeSettings(facts, fallback) {
    let snapshot = structuredClone(fallback);
    let initialized = false;
    for (const fact of facts) {
        if (fact.type === 'session_init' && isReasoningSetting(fact.reasoningEffort))
            snapshot.reasoningEffort = fact.reasoningEffort;
        else if (fact.type === 'session_bound')
            snapshot.selection = fact.model;
        else if (fact.type === 'session_settings_initialized') {
            snapshot = {
                selection: fact.model,
                reasoningEffort: fact.reasoningEffort,
                ...(fact.temperature === undefined ? {} : { temperature: fact.temperature }),
            };
            initialized = true;
        }
        else if (fact.type === 'settings_changed') {
            if (fact.key === 'agent.modelSelection') {
                const parsed = ModelSelectionSchema.safeParse(fact.value);
                if (parsed.success)
                    snapshot.selection = parsed.data;
            }
            else if (fact.key === 'agent.model' && typeof fact.value === 'string')
                snapshot.selection = { ...snapshot.selection, model: fact.value };
            else if (fact.key === 'agent.provider' && typeof fact.value === 'string')
                snapshot.selection = { ...snapshot.selection, provider: fact.value };
            else if (fact.key === 'agent.reasoningEffort' && isReasoningSetting(fact.value))
                snapshot.reasoningEffort = fact.value;
            else if (fact.key === 'agent.temperature') {
                if (isTemperatureSetting(fact.value))
                    snapshot.temperature = fact.value;
                else if (fact.value === undefined)
                    delete snapshot.temperature;
            }
        }
    }
    return { snapshot, initialized };
}
//# sourceMappingURL=settings.js.map