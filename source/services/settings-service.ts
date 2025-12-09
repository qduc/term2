import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import {z} from 'zod';
import deepEqual from 'fast-deep-equal';
import {loggingService} from './logging-service.js';

const paths = envPaths('term2');

// Define schemas for validation
const AgentSettingsSchema = z.object({
    model: z.string().min(1).default('gpt-5.1'),
    // 'default' signals we should *not* explicitly pass a reasoningEffort
    // to the API, allowing it to decide what to use.
    reasoningEffort: z
        .enum(['default', 'none', 'minimal', 'low', 'medium', 'high'])
        .default('default'),
    maxTurns: z.number().int().positive().default(100),
    retryAttempts: z.number().int().nonnegative().default(2),
    maxConsecutiveToolFailures: z.number().int().positive().default(3),
    provider: z
        .enum(['openai', 'openrouter'])
        .default('openai')
        .describe('Provider to use for the agent'),
    openrouter: z
        .object({
            apiKey: z.string().optional(),
            model: z.string().optional(),
            baseUrl: z.string().url().optional(),
            referrer: z.string().optional(),
            title: z.string().optional(),
        })
        .optional(),
});

const ShellSettingsSchema = z.object({
    timeout: z.number().int().positive().default(120000),
    maxOutputLines: z.number().int().positive().default(1000),
    maxOutputChars: z.number().int().positive().default(10000),
});

const UISettingsSchema = z.object({
    historySize: z.number().int().positive().default(1000),
});

const LoggingSettingsSchema = z.object({
    logLevel: z
        .enum(['error', 'warn', 'info', 'security', 'debug'])
        .default('info'),
    disableLogging: z.boolean().optional().default(false),
    debugLogging: z.boolean().optional().default(false),
});

const EnvironmentSettingsSchema = z.object({
    nodeEnv: z.string().optional(),
});

const AppSettingsSchema = z.object({
    shellPath: z.string().optional(),
    // Global mode controlling behavior across the app
    // - 'default': operate exactly like now
    // - 'edit': enable relaxed approvals for apply_patch within cwd
    mode: z.enum(['default', 'edit']).optional().default('default'),
});

const ToolsSettingsSchema = z.object({
    logFileOperations: z.boolean().optional().default(true),
});

const DebugSettingsSchema = z.object({
    debugBashTool: z.boolean().optional().default(false),
});

/**
 * Settings that are sensitive and should NEVER be saved to disk.
 * These are only loaded from environment variables.
 */
const SENSITIVE_SETTING_KEYS = new Set<string>([
    'agent.openrouter.apiKey',
    'agent.openrouter.baseUrl',
    'agent.openrouter.referrer',
    'agent.openrouter.title',
    'app.shellPath',
]);

const SettingsSchema = z.object({
    agent: AgentSettingsSchema.optional(),
    shell: ShellSettingsSchema.optional(),
    ui: UISettingsSchema.optional(),
    logging: LoggingSettingsSchema.optional(),
    environment: EnvironmentSettingsSchema.optional(),
    app: AppSettingsSchema.optional(),
    tools: ToolsSettingsSchema.optional(),
    debug: DebugSettingsSchema.optional(),
});

// Type definitions
export interface SettingsData {
    agent: z.infer<typeof AgentSettingsSchema>;
    shell: z.infer<typeof ShellSettingsSchema>;
    ui: z.infer<typeof UISettingsSchema>;
    logging: z.infer<typeof LoggingSettingsSchema>;
    environment: z.infer<typeof EnvironmentSettingsSchema>;
    app: z.infer<typeof AppSettingsSchema>;
    tools: z.infer<typeof ToolsSettingsSchema>;
    debug: z.infer<typeof DebugSettingsSchema>;
}

type SettingSource = 'cli' | 'env' | 'config' | 'default';
export interface SettingWithSource<T = any> {
    value: T;
    source: SettingSource;
}

export interface SettingsWithSources {
    agent: {
        model: SettingWithSource<string>;
        reasoningEffort: SettingWithSource<string>;
        maxTurns: SettingWithSource<number>;
        retryAttempts: SettingWithSource<number>;
        maxConsecutiveToolFailures: SettingWithSource<number>;
        provider: SettingWithSource<string>;
        openrouter: SettingWithSource<any>;
    };
    shell: {
        timeout: SettingWithSource<number>;
        maxOutputLines: SettingWithSource<number>;
        maxOutputChars: SettingWithSource<number>;
    };
    ui: {
        historySize: SettingWithSource<number>;
    };
    logging: {
        logLevel: SettingWithSource<string>;
        disableLogging: SettingWithSource<boolean>;
        debugLogging: SettingWithSource<boolean>;
    };
    environment: {
        nodeEnv: SettingWithSource<string | undefined>;
    };
    app: {
        shellPath: SettingWithSource<string | undefined>;
        mode: SettingWithSource<'default' | 'edit'>;
    };
    tools: {
        logFileOperations: SettingWithSource<boolean>;
    };
    debug: {
        debugBashTool: SettingWithSource<boolean>;
    };
}

/**
 * Centralized list of all setting keys for consistency across the app.
 * Used by settings command UI and other components to avoid duplication.
 */
export const SETTING_KEYS = {
    AGENT_MODEL: 'agent.model',
    AGENT_REASONING_EFFORT: 'agent.reasoningEffort',
    AGENT_PROVIDER: 'agent.provider',
    AGENT_MAX_TURNS: 'agent.maxTurns',
    AGENT_RETRY_ATTEMPTS: 'agent.retryAttempts',
    AGENT_MAX_CONSECUTIVE_TOOL_FAILURES: 'agent.maxConsecutiveToolFailures',
    AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey', // Sensitive - env only
    AGENT_OPENROUTER_MODEL: 'agent.openrouter.model',
    AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl', // Sensitive - env only
    AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer', // Sensitive - env only
    AGENT_OPENROUTER_TITLE: 'agent.openrouter.title', // Sensitive - env only
    SHELL_TIMEOUT: 'shell.timeout',
    SHELL_MAX_OUTPUT_LINES: 'shell.maxOutputLines',
    SHELL_MAX_OUTPUT_CHARS: 'shell.maxOutputChars',
    UI_HISTORY_SIZE: 'ui.historySize',
    LOGGING_LOG_LEVEL: 'logging.logLevel',
    LOGGING_DISABLE: 'logging.disableLogging',
    LOGGING_DEBUG: 'logging.debugLogging',
    ENV_NODE_ENV: 'environment.nodeEnv',
    APP_SHELL_PATH: 'app.shellPath', // Sensitive - env only
    APP_MODE: 'app.mode',
    TOOLS_LOG_FILE_OPS: 'tools.logFileOperations',
    DEBUG_BASH_TOOL: 'debug.debugBashTool',
} as const;

// Define which settings are modifiable at runtime
const RUNTIME_MODIFIABLE_SETTINGS = new Set<string>([
    SETTING_KEYS.AGENT_MODEL,
    SETTING_KEYS.AGENT_REASONING_EFFORT,
    SETTING_KEYS.AGENT_PROVIDER,
    SETTING_KEYS.SHELL_TIMEOUT,
    SETTING_KEYS.SHELL_MAX_OUTPUT_LINES,
    SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS,
    SETTING_KEYS.LOGGING_LOG_LEVEL,
    SETTING_KEYS.APP_MODE,
]);

// Note: Sensitive settings are NOT in RUNTIME_MODIFIABLE_SETTINGS because they
// cannot be modified at all - they can only be set via environment variables at startup.

// Runtime-only settings: app.mode - modifiable at runtime but never persisted to disk
// Some settings with default values are optional to persist
const OPTIONAL_DEFAULT_KEYS = new Set<string>([]);

// Default settings
const DEFAULT_SETTINGS: SettingsData = {
    agent: {
        model: 'gpt-5.1',
        reasoningEffort: 'default',
        maxTurns: 100,
        retryAttempts: 2,
        maxConsecutiveToolFailures: 3,
        provider: 'openai',
        openrouter: {
            // defaults empty; can be provided via env or config
        } as any,
    },
    shell: {
        timeout: 120000,
        maxOutputLines: 1000,
        maxOutputChars: 10000,
    },
    ui: {
        historySize: 1000,
    },
    logging: {
        logLevel: 'info',
        disableLogging: false,
        debugLogging: false,
    },
    environment: {
        nodeEnv: undefined,
    },
    app: {
        shellPath: undefined,
        mode: 'default',
    },
    tools: {
        logFileOperations: true,
    },
    debug: {
        debugBashTool: false,
    },
};

/**
 * Service for managing application settings.
 * Follows singleton pattern and supports:
 * - XDG-compliant storage
 * - Hierarchical precedence (CLI > Env > Config > Defaults)
 * - Zod validation with graceful degradation
 * - Runtime-modifiable vs startup-only settings
 * - Setting source tracking
 */
export class SettingsService {
    private settings: SettingsData;
    private sources: Map<string, SettingSource>;
    private settingsDir: string;
    private disableLogging: boolean;
    private listeners: Set<(key?: string) => void> = new Set();

    constructor(options?: {
        settingsDir?: string;
        disableLogging?: boolean;
        cli?: Partial<SettingsData>;
        env?: Partial<SettingsData>;
    }) {
        const {
            settingsDir = path.join(paths.log),
            disableLogging = false,
            cli = {},
            env = {},
        } = options ?? {};

        this.settingsDir = settingsDir;
        this.disableLogging = disableLogging;
        this.sources = new Map();

        // Ensure settings directory exists
        if (!fs.existsSync(this.settingsDir)) {
            try {
                fs.mkdirSync(this.settingsDir, {recursive: true});
            } catch (error: any) {
                if (!this.disableLogging) {
                    loggingService.error(
                        'Failed to create settings directory',
                        {
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                            path: this.settingsDir,
                        },
                    );
                }
            }
        }

        // Load settings with precedence: CLI > Env > Config > Default
        const settingsFilePath = path.join(this.settingsDir, 'settings.json');
        const configFileExisted = fs.existsSync(settingsFilePath);
        const {validated: fileConfig, raw: rawFileConfig} = this.loadFromFile();
        this.settings = this.merge(DEFAULT_SETTINGS, fileConfig, env, cli);
        this.trackSources(DEFAULT_SETTINGS, fileConfig, env, cli);

        // Apply logging level from settings to the logging service so it respects settings
        try {
            loggingService.setLogLevel(this.settings.logging.logLevel);
        } catch (error: any) {
            if (!this.disableLogging) {
                loggingService.warn(
                    'Failed to apply logging level from settings',
                    {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                        loggingLevel: this.settings.logging.logLevel,
                    },
                );
            }
        }

        if (!this.disableLogging) {
            loggingService.info('SettingsService initialized', {
                cliOverrides: Object.keys(this.flattenSettings(cli)).length > 0,
                envOverrides: Object.keys(this.flattenSettings(env)).length > 0,
                configOverrides:
                    Object.keys(this.flattenSettings(fileConfig)).length > 0,
            });
        }

        // Check if file config is missing any keys that exist in defaults
        // Use raw file config (pre-Zod) to detect missing keys since Zod adds defaults
        const shouldUpdateFile =
            configFileExisted &&
            this.hasMissingKeys(rawFileConfig, DEFAULT_SETTINGS);

        // If there was no config file on disk, persist the current merged settings so
        // users get a settings.json created at startup (rather than waiting for a
        // manual change). saveToFile is safe and handles errors/logging internally.
        // Also update the file if new settings have been added since the file was created.
        if (!configFileExisted) {
            this.saveToFile();
            if (!this.disableLogging) {
                loggingService.info('Created settings file at startup', {
                    settingsFile: settingsFilePath,
                });
            }
        } else if (shouldUpdateFile) {
            this.saveToFile();
            if (!this.disableLogging) {
                loggingService.info(
                    'Updated settings file with new default values',
                    {
                        settingsFile: settingsFilePath,
                    },
                );
            }
        }
    }

    /**
     * Get a setting value by dot-notation key (e.g., 'agent.model')
     */
    get<T = any>(key: string): T {
        const keys = key.split('.');
        let value: any = this.settings;

        for (const k of keys) {
            if (value && typeof value === 'object') {
                value = value[k];
            } else {
                return undefined as any;
            }
        }

        return value as T;
    }

    /**
     * Get the source of a setting
     */
    getSource(key: string): SettingSource {
        return this.sources.get(key) || 'default';
    }

    /**
     * Check if a setting is runtime-modifiable
     */
    isRuntimeModifiable(key: string): boolean {
        return RUNTIME_MODIFIABLE_SETTINGS.has(key);
    }

    /**
     * Check if a setting is sensitive and should not be saved to disk
     */
    isSensitive(key: string): boolean {
        return SENSITIVE_SETTING_KEYS.has(key);
    }

    /**
     * Set a setting value (runtime modification)
     * Only runtime-modifiable settings can be changed.
     * Sensitive settings cannot be modified (must come from environment).
     */
    set(key: string, value: any): void {
        if (this.isSensitive(key)) {
            throw new Error(
                `Cannot modify '${key}' - it is a sensitive setting that can only be configured via environment variables.`,
            );
        }

        if (!this.isRuntimeModifiable(key)) {
            throw new Error(
                `Cannot modify '${key}' at runtime. Requires restart.`,
            );
        }

        const keys = key.split('.');
        let obj: any = this.settings;

        // Navigate to parent
        for (let i = 0; i < keys.length - 1; i++) {
            if (!obj[keys[i]]) {
                obj[keys[i]] = {};
            }

            obj = obj[keys[i]];
        }

        // Set value
        const lastKey = keys[keys.length - 1];
        obj[lastKey] = value;

        // Track source as 'cli' for runtime-set values
        this.sources.set(key, 'cli');

        // If we're changing the logging level, update the logging service runtime
        if (key === 'logging.logLevel') {
            try {
                loggingService.setLogLevel(value);
            } catch (err: any) {
                if (!this.disableLogging) {
                    loggingService.warn(
                        'Failed to update logging level at runtime',
                        {
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                            loggingLevel: value,
                        },
                    );
                }
            }
        }

        // Persist to file
        this.saveToFile();

        this.notifyChange(key);
    }

    /**
     * Reset a setting to its default value.
     * Sensitive settings cannot be reset as they should only come from env.
     */
    reset(key?: string): void {
        if (key && this.isSensitive(key)) {
            throw new Error(
                `Cannot reset '${key}' - it is a sensitive setting that can only be configured via environment variables.`,
            );
        }

        if (key) {
            // Reset specific setting
            const keys = key.split('.');
            let obj: any = this.settings;

            // Navigate to parent
            for (let i = 0; i < keys.length - 1; i++) {
                if (!obj[keys[i]]) {
                    obj[keys[i]] = {};
                }

                obj = obj[keys[i]];
            }

            // Reset to default
            const lastKey = keys[keys.length - 1];
            const defaultKeys = key.split('.');
            let defaultValue: any = DEFAULT_SETTINGS;

            for (const k of defaultKeys) {
                defaultValue = defaultValue[k];
            }

            obj[lastKey] = defaultValue;
            this.sources.set(key, 'default');
        } else {
            // Reset all settings
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            this.sources.clear();
        }

        this.saveToFile();

        this.notifyChange(key);
    }

    /**
     * Subscribe to changes; returns an unsubscribe function.
     */
    onChange(listener: (key?: string) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notifyChange(changedKey?: string): void {
        for (const listener of this.listeners) {
            try {
                listener(changedKey);
            } catch (error: any) {
                if (!this.disableLogging) {
                    loggingService.warn('Settings change listener threw', {
                        error: error instanceof Error ? error.message : String(error),
                        changedKey,
                    });
                }
            }
        }
    }

    /**
     * Get all settings with their sources
     */
    getAll(): SettingsWithSources {
        return {
            agent: {
                model: {
                    value: this.settings.agent.model,
                    source: this.getSource('agent.model'),
                },
                reasoningEffort: {
                    value: this.settings.agent.reasoningEffort,
                    source: this.getSource('agent.reasoningEffort'),
                },
                maxTurns: {
                    value: this.settings.agent.maxTurns,
                    source: this.getSource('agent.maxTurns'),
                },
                retryAttempts: {
                    value: this.settings.agent.retryAttempts,
                    source: this.getSource('agent.retryAttempts'),
                },
                maxConsecutiveToolFailures: {
                    value: this.settings.agent.maxConsecutiveToolFailures,
                    source: this.getSource('agent.maxConsecutiveToolFailures'),
                },
                provider: {
                    value: this.settings.agent.provider,
                    source: this.getSource('agent.provider'),
                },
                openrouter: {
                    value: this.settings.agent.openrouter,
                    source: this.getSource('agent.openrouter'),
                },
            },
            shell: {
                timeout: {
                    value: this.settings.shell.timeout,
                    source: this.getSource('shell.timeout'),
                },
                maxOutputLines: {
                    value: this.settings.shell.maxOutputLines,
                    source: this.getSource('shell.maxOutputLines'),
                },
                maxOutputChars: {
                    value: this.settings.shell.maxOutputChars,
                    source: this.getSource('shell.maxOutputChars'),
                },
            },
            ui: {
                historySize: {
                    value: this.settings.ui.historySize,
                    source: this.getSource('ui.historySize'),
                },
            },
            logging: {
                logLevel: {
                    value: this.settings.logging.logLevel,
                    source: this.getSource('logging.logLevel'),
                },
                disableLogging: {
                    value: this.settings.logging.disableLogging,
                    source: this.getSource('logging.disableLogging'),
                },
                debugLogging: {
                    value: this.settings.logging.debugLogging,
                    source: this.getSource('logging.debugLogging'),
                },
            },
            environment: {
                nodeEnv: {
                    value: this.settings.environment.nodeEnv,
                    source: this.getSource('environment.nodeEnv'),
                },
            },
            app: {
                shellPath: {
                    value: this.settings.app.shellPath,
                    source: this.getSource('app.shellPath'),
                },
                mode: {
                    value: this.settings.app.mode,
                    source: this.getSource('app.mode'),
                },
            },
            tools: {
                logFileOperations: {
                    value: this.settings.tools.logFileOperations,
                    source: this.getSource('tools.logFileOperations'),
                },
            },
            debug: {
                debugBashTool: {
                    value: this.settings.debug.debugBashTool,
                    source: this.getSource('debug.debugBashTool'),
                },
            },
        };
    }

    /**
     * Load settings from file
     * Returns both raw (pre-Zod) and validated data
     */
    private loadFromFile(): {
        validated: Partial<SettingsData>;
        raw: any;
    } {
        try {
            const settingsFile = path.join(this.settingsDir, 'settings.json');

            if (!fs.existsSync(settingsFile)) {
                return {validated: {}, raw: {}};
            }

            const content = fs.readFileSync(settingsFile, 'utf-8');
            const parsed = JSON.parse(content);

            // Validate and parse with Zod
            const validated = SettingsSchema.safeParse(parsed);

            if (!validated.success) {
                if (!this.disableLogging) {
                    loggingService.warn(
                        'Settings file contains invalid values',
                        {
                            errors: validated.error.issues.map(issue => ({
                                path: issue.path.join('.'),
                                message: issue.message,
                            })),
                        },
                    );
                }

                // Return empty object to trigger defaults
                return {validated: {}, raw: parsed};
            }

            return {validated: validated.data, raw: parsed};
        } catch (error: any) {
            if (!this.disableLogging) {
                loggingService.error('Failed to load settings file', {
                    error:
                        error instanceof Error ? error.message : String(error),
                    settingsFile: path.join(this.settingsDir, 'settings.json'),
                });
            }

            return {validated: {}, raw: {}};
        }
    }

    /**
     * Save settings to file, excluding sensitive values
     */
    private saveToFile(): void {
        try {
            const settingsFile = path.join(this.settingsDir, 'settings.json');

            // Ensure directory exists
            if (!fs.existsSync(this.settingsDir)) {
                fs.mkdirSync(this.settingsDir, {recursive: true});
            }

            // Filter out sensitive settings before saving to disk
            const settingsToSave = this.stripSensitiveSettings(this.settings);
            const newContent = JSON.stringify(settingsToSave, null, 2);

            // Only write if file doesn't exist or content has changed
            // Compare parsed objects rather than string content to avoid false positives
            // from formatting differences
            if (fs.existsSync(settingsFile)) {
                try {
                    const existingContent = fs.readFileSync(settingsFile, 'utf-8');
                    const existingParsed = JSON.parse(existingContent);

                    // Deep equality check that ignores formatting and key order
                    // Uses fast-deep-equal library for robust comparison
                    if (deepEqual(existingParsed, this.settings)) {
                        return; // No changes, don't write
                    }
                } catch (parseError) {
                    // If we can't parse the existing file, write the new content anyway
                    // This handles corrupted files gracefully
                }
            }

            fs.writeFileSync(settingsFile, newContent, 'utf-8');
        } catch (error: any) {
            if (!this.disableLogging) {
                loggingService.error('Failed to save settings file', {
                    error:
                        error instanceof Error ? error.message : String(error),
                    settingsFile: path.join(this.settingsDir, 'settings.json'),
                });
            }
        }
    }

    /**
     * Remove sensitive settings that should never be persisted to disk
     */
    private stripSensitiveSettings(settings: SettingsData): Partial<SettingsData> {
        const cleaned = JSON.parse(JSON.stringify(settings));

        // Remove sensitive openrouter fields (keep non-secret config)
        if (cleaned.agent?.openrouter) {
            delete cleaned.agent.openrouter.apiKey;
            delete cleaned.agent.openrouter.baseUrl;
            delete cleaned.agent.openrouter.referrer;
            delete cleaned.agent.openrouter.title;
            // Only keep model if it's set (it's not sensitive)
            if (Object.keys(cleaned.agent.openrouter).length === 0) {
                delete cleaned.agent.openrouter;
            }
        }

        // Remove sensitive app settings
        if (cleaned.app) {
            delete cleaned.app.shellPath;
            delete cleaned.app.mode;
        }

        return cleaned;
    }

    /**
     * Check if target object is missing any keys that exist in source
     */
    private hasMissingKeys(target: any, source: any, prefix: string = ''): boolean {
        for (const key in source) {
            if (!source.hasOwnProperty(key)) continue;

            const pathKey = prefix ? `${prefix}.${key}` : key;

            const sourceValue = source[key];

            if (!(key in target)) {
                // Skip optional default keys when deciding whether to rewrite file
                if (OPTIONAL_DEFAULT_KEYS.has(pathKey)) {
                    continue;
                }
                // If the default value is undefined, treat it as optional for persistence
                if (typeof sourceValue === 'undefined') {
                    continue;
                }
                return true;
            }
            const targetValue = target[key];

            // Recursively check nested objects
            if (
                sourceValue &&
                typeof sourceValue === 'object' &&
                !Array.isArray(sourceValue) &&
                targetValue &&
                typeof targetValue === 'object' &&
                !Array.isArray(targetValue)
            ) {
                if (this.hasMissingKeys(targetValue, sourceValue, pathKey)) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Flatten nested object to dot notation
     */
    private flattenSettings(obj: any, prefix = ''): Record<string, any> {
        const result: Record<string, any> = {};

        for (const key in obj) {
            if (!obj.hasOwnProperty(key)) continue;

            const value = obj[key];
            const newKey = prefix ? `${prefix}.${key}` : key;

            if (value && typeof value === 'object' && !Array.isArray(value)) {
                Object.assign(result, this.flattenSettings(value, newKey));
            } else {
                result[newKey] = value;
            }
        }

        return result;
    }

    /**
     * Merge multiple settings sources with proper precedence
     */
    private merge(
        defaults: SettingsData,
        fileConfig: Partial<SettingsData>,
        env: Partial<SettingsData>,
        cli: Partial<SettingsData>,
    ): SettingsData {
        // Deep merge starting with defaults
        const result = JSON.parse(JSON.stringify(defaults));

        // Merge file config
        this.deepMerge(result, fileConfig);

        // Merge env
        this.deepMerge(result, env);

        // Merge cli (highest priority)
        this.deepMerge(result, cli);

        // Ensure all required fields are present
        const merged: SettingsData = {
            agent: result.agent || JSON.parse(JSON.stringify(defaults.agent)),
            shell: result.shell || JSON.parse(JSON.stringify(defaults.shell)),
            ui: result.ui || JSON.parse(JSON.stringify(defaults.ui)),
            logging:
                result.logging || JSON.parse(JSON.stringify(defaults.logging)),
            environment:
                result.environment ||
                JSON.parse(JSON.stringify(defaults.environment)),
            app: result.app || JSON.parse(JSON.stringify(defaults.app)),
            tools: result.tools || JSON.parse(JSON.stringify(defaults.tools)),
            debug: result.debug || JSON.parse(JSON.stringify(defaults.debug)),
        };

        // Validate final result
        const validated = SettingsSchema.safeParse(merged);

        if (validated.success) {
            // Ensure we return a complete SettingsData object
            return {
                agent: merged.agent,
                shell: merged.shell,
                ui: merged.ui,
                logging: merged.logging,
                environment: merged.environment,
                app: merged.app,
                tools: merged.tools,
                debug: merged.debug,
            };
        }

        // If validation fails, return defaults
        if (!this.disableLogging) {
            loggingService.warn(
                'Final merged settings failed validation, using defaults',
                {
                    errors: validated.error.issues.map(issue => ({
                        path: issue.path.join('.'),
                        message: issue.message,
                    })),
                },
            );
        }

        return defaults;
    }

    /**
     * Deep merge source into target
     */
    private deepMerge(target: any, source: any): void {
        for (const key in source) {
            if (!source.hasOwnProperty(key)) continue;

            const sourceValue = source[key];

            if (
                sourceValue &&
                typeof sourceValue === 'object' &&
                !Array.isArray(sourceValue)
            ) {
                if (!target[key] || typeof target[key] !== 'object') {
                    target[key] = {};
                }

                this.deepMerge(target[key], sourceValue);
            } else {
                target[key] = sourceValue;
            }
        }
    }

    /**
     * Track the source of each setting
     */
    private trackSources(
        defaults: SettingsData,
        fileConfig: Partial<SettingsData>,
        env: Partial<SettingsData>,
        cli: Partial<SettingsData>,
    ): void {
        const flatDefaults = this.flattenSettings(defaults);
        const flatFileConfig = this.flattenSettings(fileConfig);
        const flatEnv = this.flattenSettings(env);
        const flatCli = this.flattenSettings(cli);

        // For each possible setting key, determine its source
        for (const key in flatDefaults) {
            if (flatCli.hasOwnProperty(key)) {
                this.sources.set(key, 'cli');
            } else if (flatEnv.hasOwnProperty(key)) {
                this.sources.set(key, 'env');
            } else if (flatFileConfig.hasOwnProperty(key)) {
                this.sources.set(key, 'config');
            } else {
                this.sources.set(key, 'default');
            }
        }
    }
}

/**
 * Singleton instance for convenience
 */
// Build environment-derived overrides once at startup to preserve legacy env behavior
function buildEnvOverrides(): Partial<SettingsData> {
    const env = (typeof process !== 'undefined' ? process.env : {}) as any;
    const openrouter: any = {};
    if (env.OPENROUTER_API_KEY) openrouter.apiKey = env.OPENROUTER_API_KEY;
    if (env.OPENROUTER_MODEL) openrouter.model = env.OPENROUTER_MODEL;
    if (env.OPENROUTER_BASE_URL) openrouter.baseUrl = env.OPENROUTER_BASE_URL;
    if (env.OPENROUTER_REFERRER) openrouter.referrer = env.OPENROUTER_REFERRER;
    if (env.OPENROUTER_TITLE) openrouter.title = env.OPENROUTER_TITLE;

    const logging: any = {};
    if (env.LOG_LEVEL) logging.logLevel = env.LOG_LEVEL;
    if (env.DISABLE_LOGGING !== undefined)
        logging.disableLogging = String(env.DISABLE_LOGGING) === 'true';
    if (env.DEBUG_LOGGING !== undefined) logging.debugLogging = true;

    const environment: any = {
        nodeEnv: env.NODE_ENV,
    };

    const app: any = {
        shellPath: env.SHELL || env.COMSPEC,
    };

    const tools: any = {};
    if (env.LOG_FILE_OPERATIONS !== undefined)
        tools.logFileOperations = String(env.LOG_FILE_OPERATIONS) !== 'false';

    const debug: any = {};
    if (env.DEBUG_BASH_TOOL !== undefined) debug.debugBashTool = true;

    const agent: any = {openrouter};

    return {
        agent,
        logging,
        environment,
        app,
        tools,
        debug,
    } as Partial<SettingsData>;
}

export const settingsService = new SettingsService({
    env: buildEnvOverrides(),
});

/**
 * Publicly exported list of sensitive settings for UI/CLI components to use.
 * These settings should only be configured via environment variables.
 */
export const SENSITIVE_SETTINGS = {
    AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey',
    AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl',
    AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer',
    AGENT_OPENROUTER_TITLE: 'agent.openrouter.title',
    APP_SHELL_PATH: 'app.shellPath',
} as const;
