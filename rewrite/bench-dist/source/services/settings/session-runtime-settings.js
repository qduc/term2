import { ModelSelectionSchema } from './model-selection.js';
const efforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => Object.keys(v).every((k) => keys.includes(k));
export const isReasoningSetting = (v) => typeof v === 'string' && efforts.includes(v);
export const isTemperatureSetting = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2;
export function isNormalizedSelection(v) {
    if (!object(v) || !exact(v, ['provider', 'model']))
        return false;
    const result = ModelSelectionSchema.safeParse(v);
    return result.success && result.data.provider === v['provider'] && result.data.model === v['model'];
}
export function validateSettingsBaseline(v) {
    if (!exact(v, ['type', 'version', 'model', 'reasoningEffort', 'temperature']) ||
        v['version'] !== 1 ||
        !isNormalizedSelection(v['model']) ||
        !isReasoningSetting(v['reasoningEffort']) ||
        (Object.hasOwn(v, 'temperature') && !isTemperatureSetting(v['temperature'])))
        throw new Error('invalid session settings baseline');
}
export function validateMarkedSettings(v) {
    if (!exact(v, ['type', 'key', 'value', 'sessionMutation']) || v['sessionMutation'] !== 1)
        throw new Error('invalid session settings mutation');
    if (v['key'] === 'agent.modelSelection' && isNormalizedSelection(v['value']))
        return;
    if (v['key'] === 'agent.reasoningEffort' && isReasoningSetting(v['value']))
        return;
    if (v['key'] === 'agent.temperature' &&
        (!Object.hasOwn(v, 'value') || v['value'] === undefined || isTemperatureSetting(v['value'])))
        return;
    throw new Error('invalid session settings value');
}
export function parseRuntimeMutation(value) {
    if (!object(value))
        throw new Error('invalid settings command');
    if (value['kind'] === 'model' && exact(value, ['kind', 'selection']))
        return { kind: 'model', selection: ModelSelectionSchema.parse(value['selection']) };
    if (value['kind'] === 'reasoning' && exact(value, ['kind', 'effort']) && isReasoningSetting(value['effort']))
        return { kind: 'reasoning', effort: value['effort'] };
    if (value['kind'] === 'temperature' &&
        exact(value, ['kind', 'temperature']) &&
        (value['temperature'] === undefined || isTemperatureSetting(value['temperature'])))
        return value['temperature'] === undefined
            ? { kind: 'temperature' }
            : { kind: 'temperature', temperature: value['temperature'] };
    throw new Error('invalid settings command');
}
//# sourceMappingURL=session-runtime-settings.js.map