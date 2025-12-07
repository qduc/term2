import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import {z} from 'zod';
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
    maxTurns: z.number().int().positive().default(20),
    retryAttempts: z.number().int().nonnegative().default(2),
    provider: z
        .enum(['openai', 'openrouter'])
        .default('openai')
        .describe('Provider to use for the agent'),
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
});

const SettingsSchema = z.object({
    agent: AgentSettingsSchema.optional(),
    shell: ShellSettingsSchema.optional(),
    ui: UISettingsSchema.optional(),
    logging: LoggingSettingsSchema.optional(),
});

// Type definitions
export interface SettingsData {
    agent: z.infer<typeof AgentSettingsSchema>;
    shell: z.infer<typeof ShellSettingsSchema>;
    ui: z.infer<typeof UISettingsSchema>;
    logging: z.infer<typeof LoggingSettingsSchema>;
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
        provider: SettingWithSource<string>;
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
    SHELL_TIMEOUT: 'shell.timeout',
    SHELL_MAX_OUTPUT_LINES: 'shell.maxOutputLines',
    SHELL_MAX_OUTPUT_CHARS: 'shell.maxOutputChars',
    UI_HISTORY_SIZE: 'ui.historySize',
    LOGGING_LOG_LEVEL: 'logging.logLevel',
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
]);

// Default settings
const DEFAULT_SETTINGS: SettingsData = {
    agent: {
        model: 'gpt-5.1',
        reasoningEffort: 'default',
        maxTurns: 20,
        retryAttempts: 2,
        provider: 'openai',
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

    constructor(options?: {
        settingsDir?: string;
        disableLogging?: boolean;
        cli?: Partial<SettingsData>;
        env?: Partial<SettingsData>;
    }) {
        const {
            settingsDir = path.join(paths.log),
            disableLogging = process.env.DISABLE_LOGGING === 'true',
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
        if (!configFileExisted || shouldUpdateFile) {
            this.saveToFile();
            if (!this.disableLogging) {
                if (!configFileExisted) {
                    loggingService.info('Created settings file at startup', {
                        settingsFile: settingsFilePath,
                    });
                } else {
                    loggingService.info(
                        'Updated settings file with new default values',
                        {
                            settingsFile: settingsFilePath,
                        },
                    );
                }
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
     * Set a setting value (runtime modification)
     * Only runtime-modifiable settings can be changed
     */
    set(key: string, value: any): void {
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
    }

    /**
     * Reset a setting to its default value
     */
    reset(key?: string): void {
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
                provider: {
                    value: this.settings.agent.provider,
                    source: this.getSource('agent.provider'),
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
     * Save settings to file
     */
    private saveToFile(): void {
        try {
            const settingsFile = path.join(this.settingsDir, 'settings.json');

            // Ensure directory exists
            if (!fs.existsSync(this.settingsDir)) {
                fs.mkdirSync(this.settingsDir, {recursive: true});
            }

            fs.writeFileSync(
                settingsFile,
                JSON.stringify(this.settings, null, 2),
                'utf-8',
            );
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
     * Check if target object is missing any keys that exist in source
     */
    private hasMissingKeys(target: any, source: any): boolean {
        for (const key in source) {
            if (!source.hasOwnProperty(key)) continue;

            if (!(key in target)) {
                return true;
            }

            const sourceValue = source[key];
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
                if (this.hasMissingKeys(targetValue, sourceValue)) {
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
export const settingsService = new SettingsService();
