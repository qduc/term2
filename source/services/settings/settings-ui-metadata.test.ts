import { describe, it, expect } from 'vitest';
import { SETTING_KEYS, RUNTIME_MODIFIABLE_SETTINGS } from './settings-schema.js';
import {
  getSettingMetadata,
  isSecretSetting,
  isStringSetting,
  isNumberSetting,
  isBooleanSetting,
  isArraySetting,
  getSettingDescription,
  getAllSettingDescriptions,
} from './settings-ui-metadata.js';

describe('settings-ui-metadata (M3)', () => {
  it('derives string setting metadata', () => {
    const meta = getSettingMetadata(SETTING_KEYS.AGENT_MODEL);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('string');
    expect(meta?.isArray).toBe(false);
    expect(meta?.isSecret).toBe(false);
    expect(meta?.description).toBeTruthy();
    expect(isStringSetting(SETTING_KEYS.AGENT_MODEL)).toBe(true);
    expect(isNumberSetting(SETTING_KEYS.AGENT_MODEL)).toBe(false);
  });

  it('derives number setting metadata', () => {
    const meta = getSettingMetadata(SETTING_KEYS.SHELL_TIMEOUT);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('number');
    expect(meta?.isArray).toBe(false);
    expect(meta?.isSecret).toBe(false);
    expect(meta?.description).toBeTruthy();
    expect(isNumberSetting(SETTING_KEYS.SHELL_TIMEOUT)).toBe(true);
    expect(isStringSetting(SETTING_KEYS.SHELL_TIMEOUT)).toBe(false);
  });

  it('derives boolean setting metadata', () => {
    const meta = getSettingMetadata(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_ENABLED);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('boolean');
    expect(meta?.isArray).toBe(false);
    expect(meta?.isSecret).toBe(false);
    expect(isBooleanSetting(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_ENABLED)).toBe(true);
  });

  it('derives enum setting metadata and options', () => {
    const meta = getSettingMetadata(SETTING_KEYS.AGENT_REASONING_EFFORT);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('enum');
    expect(meta?.enumOptions).toEqual(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  });

  it('derives array setting metadata', () => {
    const meta = getSettingMetadata(SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES);
    expect(meta).toBeDefined();
    expect(meta?.type).toBe('array');
    expect(meta?.isArray).toBe(true);
    expect(isArraySetting(SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES)).toBe(true);
  });

  it('detects secret credentials via schema metadata and key naming', () => {
    expect(isSecretSetting(SETTING_KEYS.AGENT_OPENROUTER_API_KEY)).toBe(true);
    expect(isSecretSetting(SETTING_KEYS.AGENT_OPENAI_API_KEY)).toBe(true);
    expect(isSecretSetting(SETTING_KEYS.WEB_SEARCH_TAVILY_API_KEY)).toBe(true);
    expect(isSecretSetting(SETTING_KEYS.WEB_SEARCH_EXA_API_KEY)).toBe(true);
    expect(isSecretSetting('agent.custom_provider.apiKey')).toBe(true);

    expect(isSecretSetting(SETTING_KEYS.AGENT_MODEL)).toBe(false);
    expect(isSecretSetting(SETTING_KEYS.AGENT_OPENROUTER_BASE_URL)).toBe(false);
  });

  it('reflects runtime-modifiability accurately from RUNTIME_MODIFIABLE_SETTINGS', () => {
    const modifiableMeta = getSettingMetadata(SETTING_KEYS.AGENT_MAX_PARALLEL_TOOL_CALLS);
    expect(modifiableMeta?.isRuntimeModifiable).toBe(true);

    const nonModifiableKey = SETTING_KEYS.AGENT_MODEL;
    const isActuallyModifiable = RUNTIME_MODIFIABLE_SETTINGS.has(nonModifiableKey);
    const meta = getSettingMetadata(nonModifiableKey);
    expect(meta?.isRuntimeModifiable).toBe(isActuallyModifiable);
  });

  it('resolves descriptions for all SETTING_KEYS', () => {
    const allDescs = getAllSettingDescriptions();
    for (const key of Object.values(SETTING_KEYS)) {
      const desc = getSettingDescription(key);
      expect(desc, `Missing description for ${key}`).toBeTruthy();
      expect(allDescs[key]).toBe(desc);
    }
  });

  it('resolves parent description for toggles on nested objects', () => {
    const desc = getSettingDescription(SETTING_KEYS.TOOLS_SHELL_ENABLED);
    expect(desc).toBeTruthy();
    expect(desc).toContain('Enable shell tools');
  });
});
