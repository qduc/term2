import crypto from 'node:crypto';
import { ModelSelectionSchema } from '../services/settings/model-selection.js';
import { loadProviderItems } from '../providers/provider-service.js';
import { resolveProviderCredentials } from '../utils/ai/provider-credentials.js';
import { listOAuthAccounts } from '../providers/oauth-accounts.js';
const SAFE_SETTINGS_KEYS = [
    'agent.modelSelection',
    'agent.reasoningEffort',
    'agent.temperature',
    'agent.maxTurns',
    'agent.maxOutputTokens',
    'agent.maxStreamOutputChars',
    'agent.maxModelRequestDurationMs',
    'agent.retryAttempts',
    'agent.maxParallelToolCalls',
    'agent.contextCompaction.enabled',
    'agent.contextCompaction.threshold',
    'app.activeProfileId',
    'app.mentorMode',
    'app.liteMode',
    'app.planMode',
    'app.orchestratorMode',
    'webSearch.provider',
    'webSearch.firecrawl.baseUrl',
    'webSearch.searxng.baseUrl',
    'memory.enabled',
    'logging.logLevel',
    'shell.timeout',
    'shell.maxOutputLines',
    'shell.maxOutputChars',
];
/**
 * The browser may inspect the full safe-default projection, but it may only
 * persist this deliberately tiny global surface.  Session policy belongs to
 * session_update; it must never be smuggled through the launcher-wide
 * settings authority.
 */
const PERSISTENT_SETTINGS_KEYS = ['logging.logLevel'];
export class SettingsRpcError extends Error {
    code;
    details;
    constructor(code, details) {
        super('settings RPC rejected the request');
        this.name = 'SettingsRpcError';
        this.code = code;
        this.details = details;
    }
}
const CREDENTIALS = {
    openai: { settingKey: 'agent.openai.apiKey', providerId: 'openai', required: true },
    openrouter: { settingKey: 'agent.openrouter.apiKey', providerId: 'openrouter', required: true },
    tavily: { settingKey: 'webSearch.tavily.apiKey', providerId: 'tavily', required: true },
    exa: { settingKey: 'webSearch.exa.apiKey', providerId: 'exa', required: true },
    firecrawl: { settingKey: 'webSearch.firecrawl.apiKey', providerId: 'firecrawl', required: true },
};
function isSafeSettingsKey(key) {
    return SAFE_SETTINGS_KEYS.includes(key);
}
function isPersistentSettingsKey(key) {
    return PERSISTENT_SETTINGS_KEYS.includes(key);
}
export function buildSettingsProjection(settings, workspaceAccess = 'read') {
    const safeDefaults = {};
    for (const key of SAFE_SETTINGS_KEYS) {
        const actualKey = key === 'agent.contextCompaction.threshold' ? 'agent.contextCompaction.compactThreshold' : key;
        const value = settings.getDynamic(actualKey);
        const safeValue = asSafeSettingValue(value);
        const source = settings.getSource?.(actualKey) ?? 'default';
        safeDefaults[key] = {
            ...(safeValue === undefined ? {} : { value: safeValue }),
            source,
            scope: sessionScopedKey(key) ? 'session' : 'global',
            confirmRequired: key.startsWith('shell.') || key === 'agent.maxParallelToolCalls',
            persistable: isPersistentSettingsKey(key),
        };
    }
    const credentials = {};
    for (const [id, definition] of Object.entries(CREDENTIALS)) {
        credentials[id] = credentialStatus(settings, definition);
    }
    let providers = [];
    try {
        providers = loadProviderItems(settings).map((provider) => ({
            id: provider.id,
            label: provider.label,
            isCustom: provider.isCustom,
            active: provider.isActive,
            disabled: provider.isDisabled,
            credential: providerCredentialStatus(settings, provider.id),
        }));
    }
    catch {
        providers = [];
    }
    const oauthAccounts = {};
    for (const provider of ['codex', 'grok']) {
        try {
            oauthAccounts[provider] = listOAuthAccounts(provider);
        }
        catch {
            oauthAccounts[provider] = [];
        }
    }
    const approval = settings.getDynamic('shell.autoApproveMode');
    const sandboxEnabled = settings.getDynamic('sandbox.enabled') === true;
    const allowNetworking = settings.getDynamic('sandbox.allowNetworking') === true;
    const settingsOnly = {
        safeDefaults,
        credentials,
        providers,
        oauthAccounts,
        safety: {
            sandbox: sandboxEnabled ? 'enabled' : 'disabled',
            approval: approval === 'always'
                ? 'unsafe-active'
                : approval === 'auto' || approval === 'advisory' || approval === 'off'
                    ? approval
                    : 'hidden',
            backgroundShell: 'disabled-by-gateway',
            workspaceAccess,
            network: allowNetworking ? 'confirmation-required' : 'denied',
        },
    };
    const revision = crypto.createHash('sha256').update(JSON.stringify(settingsOnly)).digest('hex');
    return { schemaVersion: 1, revision, defaultsRevision: revision, settings: settingsOnly };
}
export function applySettingsChanges(settings, expectedRevision, changes) {
    const current = buildSettingsProjection(settings);
    if (current.revision !== expectedRevision)
        throw new SettingsRpcError('settings_conflict', { currentRevision: current.revision, projection: current });
    const normalized = changes.map((change) => {
        if (!isSafeSettingsKey(change.key) || !isPersistentSettingsKey(change.key))
            throw new SettingsRpcError('settings_not_allowed');
        return {
            key: change.key === 'agent.contextCompaction.threshold' ? 'agent.contextCompaction.compactThreshold' : change.key,
            value: change.value,
        };
    });
    const setter = settings.setPersistentDynamicTransaction;
    if (!setter)
        throw new SettingsRpcError('settings_unavailable');
    const result = setter.call(settings, normalized);
    if (result?.status !== 'saved')
        throw new SettingsRpcError('not_persisted');
    return buildSettingsProjection(settings);
}
export function setCredential(settings, credentialId, value) {
    const definition = CREDENTIALS[credentialId];
    if (!definition || !value)
        throw new SettingsRpcError('settings_not_allowed');
    const status = credentialStatus(settings, definition);
    if (status.source === 'environment')
        throw new SettingsRpcError('settings_not_allowed');
    if (!settings.setPersistentDynamic)
        throw new SettingsRpcError('settings_unavailable');
    const result = settings.setPersistentDynamic(definition.settingKey, value);
    if (result?.status !== 'saved')
        throw new SettingsRpcError('not_persisted');
    const next = credentialStatus(settings, definition);
    return { status: 'saved', configured: next.configured, source: next.source };
}
export function deleteCredential(settings, credentialId) {
    const definition = CREDENTIALS[credentialId];
    if (!definition || !settings.reset)
        throw new SettingsRpcError('settings_not_allowed');
    const before = credentialStatus(settings, definition);
    if (before.source === 'environment')
        return { status: 'unchanged', configured: true, source: 'environment' };
    const result = settings.reset(definition.settingKey);
    if (result?.status !== 'saved')
        throw new SettingsRpcError('not_persisted');
    return { status: 'deleted', configured: false };
}
function credentialStatus(settings, definition) {
    if (isEnvironmentSource(settings.getSource?.(definition.settingKey))) {
        return { configured: true, required: definition.required, source: 'environment', writable: false };
    }
    if (definition.providerId === 'tavily' || definition.providerId === 'exa' || definition.providerId === 'firecrawl') {
        const value = settings.getDynamic(definition.settingKey);
        const configured = typeof value === 'string' && value.trim().length > 0;
        const source = isEnvironmentSource(settings.getSource?.(definition.settingKey))
            ? 'environment'
            : configured
                ? 'setting'
                : 'missing';
        return { configured, required: definition.required, source, writable: source !== 'environment' };
    }
    const resolution = resolveProviderCredentials(settings, definition.providerId);
    return {
        configured: resolution.configured,
        required: definition.required,
        source: safeSource(resolution.source),
        writable: resolution.source !== 'environment',
    };
}
function providerCredentialStatus(settings, providerId) {
    try {
        const resolution = resolveProviderCredentials(settings, providerId);
        return {
            configured: resolution.configured,
            required: resolution.required,
            source: safeSource(resolution.source),
            writable: resolution.source !== 'environment',
        };
    }
    catch {
        return { configured: false, required: false, source: 'missing', writable: false };
    }
}
function safeSource(source) {
    return source;
}
function isEnvironmentSource(source) {
    return source === 'env' || source === 'environment';
}
function sessionScopedKey(key) {
    return (key === 'agent.modelSelection' ||
        key === 'agent.reasoningEffort' ||
        key === 'app.activeProfileId' ||
        key === 'app.mentorMode' ||
        key === 'app.liteMode' ||
        key === 'app.planMode' ||
        key === 'app.orchestratorMode');
}
function asSafeSettingValue(value) {
    const selection = ModelSelectionSchema.safeParse(value);
    if (selection.success)
        return selection.data;
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
        return value;
    return undefined;
}
//# sourceMappingURL=settings-rpc.js.map