import { it, expect } from 'vitest';
import {
  formatDurationMs,
  formatUsdMicros,
  formatMilestones,
  formatSettingDisplayValue,
} from './settings-value-formatter.js';
import { SETTING_KEYS } from '../../services/settings/settings-schema.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

it('formatDurationMs formats exact hours, minutes, and seconds', () => {
  expect(formatDurationMs(3600000)).toBe('1h');
  expect(formatDurationMs(7200000)).toBe('2h');
  expect(formatDurationMs(86400000)).toBe('24h');
  expect(formatDurationMs(60000)).toBe('1m');
  expect(formatDurationMs(120000)).toBe('2m');
  expect(formatDurationMs(300000)).toBe('5m');
  expect(formatDurationMs(600000)).toBe('10m');
  expect(formatDurationMs(900000)).toBe('15m');
  expect(formatDurationMs(1800000)).toBe('30m');
  expect(formatDurationMs(1000)).toBe('1s');
  expect(formatDurationMs(5000)).toBe('5s');
  expect(formatDurationMs(120000)).toBe('2m');
  expect(formatDurationMs(0, false)).toBe('0s');
  expect(formatDurationMs(0, true)).toBe('disabled (0s)');
});

it('formatUsdMicros formats micro-dollars into readable currency', () => {
  expect(formatUsdMicros(5000000)).toBe('$5.00');
  expect(formatUsdMicros(1000000)).toBe('$1.00');
  expect(formatUsdMicros(250000)).toBe('$0.25');
  expect(formatUsdMicros(100000)).toBe('$0.10');
  expect(formatUsdMicros(10000000)).toBe('$10.00');
});

it('formatMilestones formats context token milestones', () => {
  expect(formatMilestones([200000, 300000, 400000])).toBe('200k, 300k, 400k');
  expect(formatMilestones([])).toBe('(none)');
});

it('formatSettingDisplayValue formats secrets masked or <empty>', () => {
  const masked = formatSettingDisplayValue(SETTING_KEYS.AGENT_OPENAI_API_KEY, 'sk-secret123');
  expect(masked.text).toBe('********');
  expect(masked.color).toBe(COLOR_TEXT_SUBTLE);

  const empty = formatSettingDisplayValue(SETTING_KEYS.AGENT_OPENAI_API_KEY, '');
  expect(empty.text).toBe('<empty>');
  expect(empty.color).toBe(COLOR_TEXT_SUBTLE);
});

it('formatSettingDisplayValue formats booleans as ON/OFF', () => {
  const on = formatSettingDisplayValue(SETTING_KEYS.AGENT_BACKGROUND_CHECK_IN_ENABLED, true);
  expect(on.text).toBe('ON');
  expect(on.color).toBe(COLOR_SUCCESS);

  const off = formatSettingDisplayValue(SETTING_KEYS.AGENT_BACKGROUND_CHECK_IN_ENABLED, false);
  expect(off.text).toBe('OFF');
  expect(off.color).toBe(COLOR_DANGER);
});

it('formatSettingDisplayValue formats durations in milliseconds', () => {
  const activeTime = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_MAX_ACTIVE_TIME_MS, 3600000);
  expect(activeTime.text).toBe('1h');
  expect(activeTime.color).toBe(COLOR_WARNING);

  const warningTime = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_WARNING_HEADROOM_ACTIVE_TIME_MS, 900000);
  expect(warningTime.text).toBe('15m');

  const shellTimeout = formatSettingDisplayValue(SETTING_KEYS.SHELL_TIMEOUT, 120000);
  expect(shellTimeout.text).toBe('2m');

  const idleStream = formatSettingDisplayValue(SETTING_KEYS.AGENT_MAX_MODEL_STREAM_IDLE_MS, 600000);
  expect(idleStream.text).toBe('10m');

  const hookTimeout = formatSettingDisplayValue(SETTING_KEYS.HOOKS_TIMEOUT_MS, 5000);
  expect(hookTimeout.text).toBe('5s');

  const reqDurationDisabled = formatSettingDisplayValue(SETTING_KEYS.AGENT_MAX_MODEL_REQUEST_DURATION_MS, 0);
  expect(reqDurationDisabled.text).toBe('disabled (0s)');
  expect(reqDurationDisabled.color).toBe(COLOR_TEXT_SUBTLE);
});

it('formatSettingDisplayValue formats USD micros', () => {
  const maxBudget = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_MAX_USD_MICROS, 5000000);
  expect(maxBudget.text).toBe('$5.00');
  expect(maxBudget.color).toBe(COLOR_WARNING);

  const warningBudget = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_WARNING_HEADROOM_USD_MICROS, 1000000);
  expect(warningBudget.text).toBe('$1.00');

  const softBudget = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_SOFT_HEADROOM_USD_MICROS, 250000);
  expect(softBudget.text).toBe('$0.25');
});

it('formatSettingDisplayValue formats percentages', () => {
  const compactThreshold = formatSettingDisplayValue(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD, 0.8);
  expect(compactThreshold.text).toBe('80%');
  expect(compactThreshold.color).toBe(COLOR_WARNING);

  const extension = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_EXTENSION_PERCENT, 50);
  expect(extension.text).toBe('50%');
  expect(extension.color).toBe(COLOR_WARNING);
});

it('formatSettingDisplayValue formats token and character counts', () => {
  const unpriced = formatSettingDisplayValue(SETTING_KEYS.AGENT_RUN_BUDGET_MAX_UNPRICED_TOKENS, 5000000);
  expect(unpriced.text).toBe('5,000,000 tokens');
  expect(unpriced.color).toBe(COLOR_WARNING);

  const maxOutputTokens = formatSettingDisplayValue(SETTING_KEYS.AGENT_MAX_OUTPUT_TOKENS, 32000);
  expect(maxOutputTokens.text).toBe('32,000 tokens');

  const streamChars = formatSettingDisplayValue(SETTING_KEYS.AGENT_MAX_STREAM_OUTPUT_CHARS, 100000);
  expect(streamChars.text).toBe('100,000 chars');

  const memoryChars = formatSettingDisplayValue(SETTING_KEYS.MEMORY_CONTEXT_BUDGET_CHARS, 50000);
  expect(memoryChars.text).toBe('50,000 chars');

  const maxLines = formatSettingDisplayValue(SETTING_KEYS.SHELL_MAX_OUTPUT_LINES, 500);
  expect(maxLines.text).toBe('500 lines');
});

it('formatSettingDisplayValue formats rollover milestones array', () => {
  const milestones = formatSettingDisplayValue(
    SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES,
    [200000, 300000, 400000],
  );
  expect(milestones.text).toBe('200k, 300k, 400k');
  expect(milestones.color).toBe(COLOR_WARNING);

  const emptyMilestones = formatSettingDisplayValue(SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES, []);
  expect(emptyMilestones.text).toBe('(none)');
  expect(emptyMilestones.color).toBe(COLOR_TEXT_SUBTLE);
});

it('formatSettingDisplayValue formats empty arrays and collections as (none)', () => {
  const favModels = formatSettingDisplayValue(SETTING_KEYS.AGENT_FAVORITE_MODELS, []);
  expect(favModels.text).toBe('(none)');
  expect(favModels.color).toBe(COLOR_TEXT_SUBTLE);

  const nicknames = formatSettingDisplayValue(SETTING_KEYS.AGENT_MODEL_NICKNAMES, {});
  expect(nicknames.text).toBe('(none)');
  expect(nicknames.color).toBe(COLOR_TEXT_SUBTLE);

  const mentorPool = formatSettingDisplayValue(SETTING_KEYS.AGENT_MENTOR_POOL, []);
  expect(mentorPool.text).toBe('(none)');
});

it('formatSettingDisplayValue formats undefined/inherited values with informative fallbacks', () => {
  const smartModel = formatSettingDisplayValue(SETTING_KEYS.AGENT_SMART_MODEL, undefined);
  expect(smartModel.text).toBe('(inherits agent.model)');
  expect(smartModel.color).toBe(COLOR_TEXT_SUBTLE);

  const balancedProvider = formatSettingDisplayValue(SETTING_KEYS.AGENT_BALANCED_PROVIDER, undefined);
  expect(balancedProvider.text).toBe('(inherits agent.provider)');

  const smartReasoning = formatSettingDisplayValue(SETTING_KEYS.AGENT_SMART_REASONING_EFFORT, undefined);
  expect(smartReasoning.text).toBe('(default)');

  const unsetGeneral = formatSettingDisplayValue(SETTING_KEYS.AGENT_MENTOR_MODEL, undefined);
  expect(unsetGeneral.text).toBe('(none)');
});

it('formatSettingDisplayValue formats null values correctly', () => {
  const compactTokens = formatSettingDisplayValue(SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS, null);
  expect(compactTokens.text).toBe('disabled');
  expect(compactTokens.color).toBe(COLOR_TEXT_SUBTLE);
});
