import { SETTING_KEYS } from '../../services/settings/settings-schema.js';
import { isDurationSetting, isSecretSetting, isUsdMicrosSetting, } from '../../services/settings/settings-ui-metadata.js';
/** Shorten text to `max` chars, keeping the start and marking the cut. */
export function truncateText(text, max) {
    if (text.length <= max)
        return text;
    return text.slice(0, Math.max(0, max - 1)) + '…';
}
/** Shorten text to `max` chars, keeping the end (the meaningful part of a path). */
export function truncateStart(text, max) {
    if (text.length <= max)
        return text;
    return '…' + text.slice(text.length - Math.max(0, max - 1));
}
function isBoundModel(value) {
    return (value !== null &&
        typeof value === 'object' &&
        typeof value.model === 'string' &&
        typeof value.provider === 'string');
}
/**
 * Drop schema notation that only helps someone editing the JSON file — type
 * hints like `(true|false)` or `(number)`, and stored units the menu already
 * converts (milliseconds, USD micros) — so the menu reads as plain language.
 */
export function cleanSettingDescription(description) {
    return description
        .replace(/\s*\((?:[\w~:-]+\|)+[\w~:-]+(?:[,;]\s*([^)]*))?\)/g, (_match, rest) => rest ? ` (${rest.trim()})` : '')
        .replace(/\s*\((?:number|path|JSON array|comma-separated)\)/g, '')
        .replace(/,?\s*in milliseconds\b/g, '')
        .replace(/\bthis many milliseconds\b/g, 'this long')
        .replace(/\s+([.,;])/g, '$1')
        .trim();
}
export function formatDurationMs(ms, isOptionalCeiling = false) {
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
export function formatUsdMicros(micros) {
    const dollars = micros / 1_000_000;
    return `$${dollars.toFixed(2)}`;
}
export function formatNumber(num) {
    return num.toLocaleString('en-US');
}
export function formatMilestones(milestones) {
    if (milestones.length === 0)
        return '(none)';
    return milestones
        .map((m) => {
        if (typeof m !== 'number')
            return String(m);
        if (m >= 1000 && m % 1000 === 0)
            return `${m / 1000}k`;
        return formatNumber(m);
    })
        .join(', ');
}
export function formatSettingDisplayValue(key, value) {
    // 1. Secrets are masked or shown as <empty>
    if (isSecretSetting(key)) {
        return {
            text: value ? '********' : '<empty>',
            tone: 'textSubtle',
        };
    }
    // 2. Booleans
    if (typeof value === 'boolean') {
        const text = value ? 'ON' : 'OFF';
        return {
            text,
            tone: value ? 'success' : 'danger',
        };
    }
    // 3. Ancillary inheritances and optional defaults when undefined or empty string
    if (value === undefined || value === '') {
        if (key === SETTING_KEYS.AGENT_SMART_MODEL ||
            key === SETTING_KEYS.AGENT_BALANCED_MODEL ||
            key === SETTING_KEYS.AGENT_CHEAP_MODEL ||
            key === SETTING_KEYS.AGENT_CHORE_MODEL) {
            return { text: '(inherits agent.modelSelection)', tone: 'textSubtle' };
        }
        if (key === SETTING_KEYS.AGENT_SMART_REASONING_EFFORT ||
            key === SETTING_KEYS.AGENT_BALANCED_REASONING_EFFORT ||
            key === SETTING_KEYS.AGENT_CHEAP_REASONING_EFFORT) {
            return { text: '(default)', tone: 'textSubtle' };
        }
        if (key === SETTING_KEYS.WEB_SEARCH_PROVIDER || key === SETTING_KEYS.UI_PASTE_THRESHOLD) {
            return { text: '(none)', tone: 'textSubtle' };
        }
        return { text: '(unset)', tone: 'textSubtle' };
    }
    // 4. Explicit null
    if (value === null) {
        if (key === SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD_TOKENS) {
            return { text: 'disabled', tone: 'textSubtle' };
        }
        return { text: '(none)', tone: 'textSubtle' };
    }
    // If a JSON string representation was passed (e.g. from JSON serialization), parse it
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
        try {
            const parsed = JSON.parse(value);
            return formatSettingDisplayValue(key, parsed);
        }
        catch {
            // Not valid JSON, continue with normal string formatting
        }
    }
    // 5. Durations / Timeouts (in milliseconds)
    const isDurationKey = isDurationSetting(key);
    if (isDurationKey && typeof value === 'number') {
        const isOptionalCeiling = key === SETTING_KEYS.AGENT_MAX_MODEL_REQUEST_DURATION_MS;
        const text = formatDurationMs(value, isOptionalCeiling);
        return {
            text,
            tone: value === 0 && isOptionalCeiling ? 'textSubtle' : 'warning',
        };
    }
    // 6. Currency (USD micros: 1,000,000 = $1.00)
    if (key.endsWith('UsdMicros') && typeof value === 'number') {
        return {
            text: formatUsdMicros(value),
            tone: 'warning',
        };
    }
    // 7. Percentages & Ratios
    if (key === SETTING_KEYS.AGENT_CONTEXT_COMPACTION_COMPACT_THRESHOLD && typeof value === 'number') {
        return {
            text: `${Math.round(value * 100)}%`,
            tone: 'warning',
        };
    }
    if (key === SETTING_KEYS.AGENT_RUN_BUDGET_EXTENSION_PERCENT && typeof value === 'number') {
        return {
            text: `${value}%`,
            tone: 'warning',
        };
    }
    // 8. Large counts (Tokens / Chars / Lines)
    if ((key.endsWith('UnpricedTokens') || key === SETTING_KEYS.AGENT_MAX_OUTPUT_TOKENS) && typeof value === 'number') {
        return {
            text: `${formatNumber(value)} tokens`,
            tone: 'warning',
        };
    }
    if ((key.endsWith('Chars') || key === SETTING_KEYS.MEMORY_CONTEXT_BUDGET_CHARS) && typeof value === 'number') {
        return {
            text: `${formatNumber(value)} chars`,
            tone: 'warning',
        };
    }
    if (key === SETTING_KEYS.SHELL_MAX_OUTPUT_LINES && typeof value === 'number') {
        return {
            text: `${formatNumber(value)} lines`,
            tone: 'warning',
        };
    }
    // 9. Session Rollover Milestones
    if (key === SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES) {
        if (Array.isArray(value)) {
            return {
                text: formatMilestones(value),
                tone: value.length === 0 ? 'textSubtle' : 'warning',
            };
        }
    }
    // 10. Model selections: show the model, not the shape of the value
    if (isBoundModel(value)) {
        return { text: `${value.provider}/${value.model}`, tone: 'accent' };
    }
    if (Array.isArray(value) && value.length > 0 && value.every(isBoundModel)) {
        const [first, ...rest] = value;
        return { text: rest.length > 0 ? `${first.model} +${rest.length} more` : first.model, tone: 'accent' };
    }
    // 11. Arrays & Objects
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return { text: '(none)', tone: 'textSubtle' };
        }
        if (value.every((item) => typeof item === 'string')) {
            const [first, ...rest] = value;
            return { text: rest.length > 0 ? `${first} +${rest.length} more` : first, tone: 'accent' };
        }
        return {
            text: `${value.length} ${value.length === 1 ? 'item' : 'items'}`,
            tone: 'accent',
        };
    }
    if (typeof value === 'object') {
        const keys = Object.keys(value);
        if (keys.length === 0) {
            return { text: '(none)', tone: 'textSubtle' };
        }
        // A name -> value map (model nicknames): the names are what you scan for.
        if (Object.values(value).every((entry) => typeof entry === 'string')) {
            const [first, ...rest] = keys;
            return {
                text: rest.length > 0 ? `${first}, ${rest[0]}${rest.length > 1 ? ` +${rest.length - 1} more` : ''}` : first,
                tone: 'accent',
            };
        }
        return {
            text: `${keys.length} ${keys.length === 1 ? 'entry' : 'entries'}`,
            tone: 'accent',
        };
    }
    // 12. Generic Numbers
    if (typeof value === 'number') {
        return { text: String(value), tone: 'warning' };
    }
    // 13. Generic Strings (the list fits them to the available width)
    return { text: String(value), tone: 'accent' };
}
/**
 * Full, untruncated text for a setting value — used where there is room to
 * show everything (the value editor header, save confirmations). Lists and
 * maps render as JSON instead of an item count; secrets stay masked.
 */
export function formatSettingValueDetail(key, value) {
    if (isSecretSetting(key))
        return value ? '********' : '<empty>';
    if (Array.isArray(value) && value.length > 0 && value.every(isBoundModel)) {
        return value.map((entry) => `${entry.provider}/${entry.model}`).join(', ');
    }
    if (Array.isArray(value) && value.length > 0 && key !== SETTING_KEYS.AGENT_SESSION_ROLLOVER_MILESTONES) {
        return JSON.stringify(value);
    }
    if (isBoundModel(value))
        return `${value.provider}/${value.model}`;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
        return JSON.stringify(value);
    }
    if (typeof value === 'string' && value !== '')
        return value;
    if (isUsdMicrosSetting(key) && typeof value === 'number') {
        // Sub-cent amounts would round to $0.00; show them exactly.
        return value % 10_000 === 0 ? formatUsdMicros(value) : `$${value / 1_000_000}`;
    }
    return formatSettingDisplayValue(key, value).text;
}
//# sourceMappingURL=settings-value-formatter.js.map