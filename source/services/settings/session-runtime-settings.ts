import { ModelSelectionSchema, type ModelSelection } from './model-selection.js';
type ReasoningEffortSetting = 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type RuntimeSettingsSnapshot = {
  selection: ModelSelection;
  reasoningEffort: ReasoningEffortSetting;
  temperature?: number;
};
export type RuntimeSettingMutation =
  | { kind: 'model'; selection: ModelSelection }
  | { kind: 'reasoning'; effort: ReasoningEffortSetting }
  | { kind: 'temperature'; temperature?: number };
export type SessionSettingsInitialized = {
  type: 'session_settings_initialized';
  version: 1;
  model: ModelSelection;
  reasoningEffort: ReasoningEffortSetting;
  temperature?: number;
};
const efforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
export const isReasoningSetting = (v: unknown): v is ReasoningEffortSetting =>
  typeof v === 'string' && efforts.includes(v);
export const isTemperatureSetting = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2;
export function isNormalizedSelection(v: unknown): v is ModelSelection {
  if (!object(v) || !exact(v, ['provider', 'model'])) return false;
  const result = ModelSelectionSchema.safeParse(v);
  return result.success && result.data.provider === v['provider'] && result.data.model === v['model'];
}
export function validateSettingsBaseline(v: Record<string, unknown>): void {
  if (
    !exact(v, ['type', 'version', 'model', 'reasoningEffort', 'temperature']) ||
    v['version'] !== 1 ||
    !isNormalizedSelection(v['model']) ||
    !isReasoningSetting(v['reasoningEffort']) ||
    (Object.hasOwn(v, 'temperature') && !isTemperatureSetting(v['temperature']))
  )
    throw new Error('invalid session settings baseline');
}
export function validateMarkedSettings(v: Record<string, unknown>): void {
  if (!exact(v, ['type', 'key', 'value', 'sessionMutation']) || v['sessionMutation'] !== 1)
    throw new Error('invalid session settings mutation');
  if (v['key'] === 'agent.modelSelection' && isNormalizedSelection(v['value'])) return;
  if (v['key'] === 'agent.reasoningEffort' && isReasoningSetting(v['value'])) return;
  if (
    v['key'] === 'agent.temperature' &&
    (!Object.hasOwn(v, 'value') || v['value'] === undefined || isTemperatureSetting(v['value']))
  )
    return;
  throw new Error('invalid session settings value');
}
export function parseRuntimeMutation(value: unknown): RuntimeSettingMutation {
  if (!object(value)) throw new Error('invalid settings command');
  if (value['kind'] === 'model' && exact(value, ['kind', 'selection']))
    return { kind: 'model', selection: ModelSelectionSchema.parse(value['selection']) };
  if (value['kind'] === 'reasoning' && exact(value, ['kind', 'effort']) && isReasoningSetting(value['effort']))
    return { kind: 'reasoning', effort: value['effort'] };
  if (
    value['kind'] === 'temperature' &&
    exact(value, ['kind', 'temperature']) &&
    (value['temperature'] === undefined || isTemperatureSetting(value['temperature']))
  )
    return value['temperature'] === undefined
      ? { kind: 'temperature' }
      : { kind: 'temperature', temperature: value['temperature'] };
  throw new Error('invalid settings command');
}
