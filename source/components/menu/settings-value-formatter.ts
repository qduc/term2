import fs from 'node:fs';
import { SETTING_KEYS } from '../../services/settings/settings-schema.js';
import { isSecretSetting } from '../../services/settings/settings-ui-metadata.js';
import { getRtkBinaryPath } from '../../services/rtk-service.js';
import { COLOR_ACCENT, COLOR_DANGER, COLOR_SUCCESS, COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

export interface FormattedSettingValue {
  text: string;
  color?: string;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + '…';
}

export function formatDurationMs(ms: number, isOptionalCeiling: boolean = false): string {
  if (ms === 0) {
    return isOptionalCeiling ? 'disabled (0s)' : '0s';
  }
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) {
    return `${ms / 3_600_000}h`;
  }
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return `${ms / 60_000}m`;
  }
  if (ms >= 1_000 && ms % 1_000 === 0) {
    return `${ms / 1_000}s`;
  }
  if (ms >= 60_000) {
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1_000);
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }
  if (ms >= 1_000) {
    const secs = (ms / 1_000).toFixed(1).replace(/\.0$/, '');
    return `${secs}s`;
  }
  return `${ms}ms`;
}

export function formatUsdMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(2)}`;
}

export function formatNumber(num: number): string {
  return num.toLocaleString('en-US');
}

export function formatMilestones(milestones: number[]): string {
  if (milestones.length === 0) return '(none)';
  return milestones
    .map((m) => {
      if (typeof m !== 'number') return String(m);
      if (m >= 1000 && m % 1000 === 0) return `${m / 1000}k`;
      return formatNumber(m);
    })
    .join(', ');
}

export function formatSettingDisplayValue(key: string, value: unknown): FormattedSettingValue {
  // 1. Secrets are masked or shown as <empty>
  if (isSecretSetting(key)) {
    return {
      text: value ? '********' : '<empty>',
      color: COLOR_TEXT_SUBTLE,
    };
  }

  // 2. Booleans
  if (typeof value === 'boolean') {
    let text = value ? 'ON' : 'OFF';
    if (value && key === SETTING_KEYS.SHELL_USE_RTK_COMPRESSION && fs.existsSync(getRtkBinaryPath())) {
      text += ' (installed)';
    }
    return {
      text,
      color: value ? COLOR_SUCCESS : COLOR_DANGER,
    };
  }

  // 3. Ancillary inheritances and optional defaults when undefined or empty string
  if (value === undefined || value === '') {
    if (
      key === SETTING_KEYS.AGENT_SMART_MODEL ||
      key === SETTING_KEYS.AGENT_BALANCED_MODEL ||
      key === SETTING_KEYS.AGENT_CHEAP_MODEL ||
      key === SETTING_KEYS.AGENT_CHORE_MODEL
    ) {
      return { text: '(inherits agent.model)', color: COLOR_TEXT_SUBTLE };
    }
    if (
      key === SETTING_KEYS.AGENT_SMART_PROVIDER ||
      key === SETTING_KEYS.AGENT_BALANCED_PROVIDER ||
      key === SETTING_KEYS.AGENT_CHEAP_PROVIDER ||
      key === SETTING_KEYS.AGENT_CHORE_PROVIDER ||
      key === SETTING_KEYS.AGENT_AUTO_APPROVE_PROVIDER
    ) {
      return { text: '(inherits agent.provider)', color: COLOR_TEXT_SUBTLE };
    }
    if (
      key === SETTING_KEYS.AGENT_SMART_REASONING_EFFORT ||
      key === SETTING_KEYS.AGENT_BALANCED_REASONING_EFFORT ||
      key === SETTING_KEYS.AGENT_CHEAP_REASONING_EFFORT
    ) {
      return { text: '(default)', color: COLOR_TEXT_SUBTLE };
    }
    if (
      key === SETTING_KEYS.AGENT_MENTOR_MODEL ||
      key === SETTING_KEYS.AGENT_MENTOR_PROVIDER ||
      key === SETTING_KEYS.WEB_SEARCH_PROVIDER ||
      key === SETTING_KEYS.UI_PASTE_THRESHOLD
    ) {
      return { text: '(none)', color: COLOR_TEXT_SUBTLE };
    }
    return { text: '(unset)', color: COLOR_TEXT_SUBTLE };
  }

  // 4. Explicit null
  if (value === null) {
    if (key === SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS) {
      return { text: 'disabled', color: COLOR_TEXT_SUBTLE };
    }
    return { text: '(none)', color: COLOR_TEXT_SUBTLE };
  }

  // If a JSON string representation was passed (e.g. from JSON serialization), parse it
  if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
    try {
      const parsed = JSON.parse(value);
      return formatSettingDisplayValue(key, parsed);
    } catch {
      // Not valid JSON, continue with normal string formatting
    }
  }

  // 5. Durations / Timeouts (in milliseconds)
  const isDurationKey =
    key.endsWith('Ms') || key === SETTING_KEYS.SHELL_TIMEOUT || key === SETTING_KEYS.SHELL_BACKGROUND_TIMEOUT;

  if (isDurationKey && typeof value === 'number') {
    const isOptionalCeiling = key === SETTING_KEYS.AGENT_MAX_MODEL_REQUEST_DURATION_MS;
    const text = formatDurationMs(value, isOptionalCeiling);
    return {
      text,
      color: value === 0 && isOptionalCeiling ? COLOR_TEXT_SUBTLE : COLOR_WARNING,
    };
  }

  // 6. Currency (USD micros: 1,000,000 = $1.00)
  if (key.endsWith('UsdMicros') && typeof value === 'number') {
    return {
      text: formatUsdMicros(value),
      color: COLOR_WARNING,
    };
  }

  // 7. Percentages & Ratios
  if (key === SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD && typeof value === 'number') {
    return {
      text: `${Math.round(value * 100)}%`,
      color: COLOR_WARNING,
    };
  }
  if (key === SETTING_KEYS.AGENT_RUN_BUDGET_EXTENSION_PERCENT && typeof value === 'number') {
    return {
      text: `${value}%`,
      color: COLOR_WARNING,
    };
  }

  // 8. Large counts (Tokens / Chars / Lines)
  if ((key.endsWith('UnpricedTokens') || key === SETTING_KEYS.AGENT_MAX_OUTPUT_TOKENS) && typeof value === 'number') {
    return {
      text: `${formatNumber(value)} tokens`,
      color: COLOR_WARNING,
    };
  }
  if ((key.endsWith('Chars') || key === SETTING_KEYS.MEMORY_CONTEXT_BUDGET_CHARS) && typeof value === 'number') {
    return {
      text: `${formatNumber(value)} chars`,
      color: COLOR_WARNING,
    };
  }
  if (key === SETTING_KEYS.SHELL_MAX_OUTPUT_LINES && typeof value === 'number') {
    return {
      text: `${formatNumber(value)} lines`,
      color: COLOR_WARNING,
    };
  }

  // 9. Session Rollover Milestones
  if (key === SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES) {
    if (Array.isArray(value)) {
      return {
        text: formatMilestones(value),
        color: value.length === 0 ? COLOR_TEXT_SUBTLE : COLOR_WARNING,
      };
    }
  }

  // 10. Arrays & Objects
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return { text: '(none)', color: COLOR_TEXT_SUBTLE };
    }
    if (value.every((item) => typeof item === 'string') && value.length <= 2) {
      const joined = value.join(', ');
      if (joined.length <= 30) {
        return { text: truncate(joined, 40), color: COLOR_ACCENT };
      }
    }
    return {
      text: `${value.length} ${value.length === 1 ? 'item' : 'items'}`,
      color: COLOR_ACCENT,
    };
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) {
      return { text: '(none)', color: COLOR_TEXT_SUBTLE };
    }
    return {
      text: `${keys.length} ${keys.length === 1 ? 'entry' : 'entries'}`,
      color: COLOR_ACCENT,
    };
  }

  // 11. Generic Numbers
  if (typeof value === 'number') {
    return { text: String(value), color: COLOR_WARNING };
  }

  // 12. Generic Strings
  const str = String(value);
  return {
    text: truncate(str, 40),
    color: COLOR_ACCENT,
  };
}
