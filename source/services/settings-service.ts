import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import {z} from 'zod';
import deepEqual from 'fast-deep-equal';
import {LoggingService} from './logging-service.js';
// Import providers to ensure they're registered before schema construction
import '../providers/index.js';
import {
    getAllProviders,
    getProvider,
    upsertProvider,
} from '../providers/index.js';
import {createOpenAICompatibleProviderDefinition} from '../providers/openai-compatible.provider.js';

const paths = envPaths('term2');

// Define schemas for validation
const AgentSettingsSchema = z.object({
    model: z.string().min(1).default('gpt-5.1'),
    // 'default' signals we should *not* explicitly pass a reasoningEffort
    // to the API, allowing it to decide what to use.
    reasoningEffort: z
        .enum(['default', 'none', 'minimal', 'low', 'medium', 'high'])
        .default('default'),
    // Temperature controls randomness. We keep it optional so providers/models
    // can use their own defaults when unset.
    temperature: z.number().min(0).max(2).optional(),
    maxTurns: z.number().int().positive().default(100),
    retryAttempts: z.number().int().nonnegative().default(2),
    // NOTE: We do NOT validate provider existence here because the provider
    // registry can be extended at runtime from settings.json (custom providers).
    // We validate/fallback after SettingsService loads and registers runtime providers.
    provider: z
        .string()
        .min(1)
        .default('openai')
        .describe('Provider to use for the agent'),
    openrouter: z
        .object({
            apiKey: z.string().optional(),
            baseUrl: z.string().url().optional(),
            referrer: z.string().optional(),
            title: z.string().optional(),
        })
        .optional(),
    mentorModel: z.string().optional().describe('Model to use as a mentor'),
    mentorReasoningEffort: z
        .enum(['default', 'none', 'minimal', 'low', 'medium', 'high'])
        .default('default')
        .describe('Reasoning effort for the mentor model'),
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
    suppressConsoleOutput: z.boolean().optional().default(true),
});

const EnvironmentSettingsSchema = z.object({
    nodeEnv: z.string().optional(),
});

const AppSettingsSchema = z.object({
    shellPath: z.string().optional(),
    // Independent mode flags that can be enabled together and persist across sessions
    // mentorMode: uses simplified mentor prompt and enables ask_mentor tool (if mentorModel configured)
    // editMode: auto-approves apply_patch operations within cwd for faster file editing
    mentorMode: z.boolean().optional().default(false),
    editMode: z.boolean().optional().default(false),
});

const ToolsSettingsSchema = z.object({
    logFileOperations: z.boolean().optional().default(true),
});

const DebugSettingsSchema = z.object({
    debugBashTool: z.boolean().optional().default(false),
});

const CompanionSettingsSchema = z.object({
    // Feature toggles
    enabled: z.boolean().default(false)
        .describe('Enable companion mode features'),
    showHints: z.boolean().default(true)
        .describe('Show smart hints in status bar'),

    // Smart trigger thresholds
    errorCascadeThreshold: z.number().int().min(1).default(3)
        .describe('Consecutive failures before showing hint'),
    retryLoopThreshold: z.number().int().min(1).default(2)
        .describe('Repeated commands before showing hint'),
    pauseHintDelayMs: z.number().int().min(0).default(30000)
        .describe('Milliseconds of inactivity after error before hint'),

    // Context management
    maxContextBufferSize: z.number().int().min(1024).default(1048576)
        .describe('Maximum buffer size in bytes (default: 1MB)'),
    maxCommandIndexSize: z.number().int().min(1).max(50).default(10)
        .describe('Number of commands in lightweight index'),

    // Summarizer configuration
    summarizerModel: z.string().default('gpt-4o-mini')
        .describe('Model for output summarization'),
    summarizerProvider: z.string().default('openai')
        .describe('Provider for summarizer model'),
    summarizerMaxTokens: z.number().int().min(100).default(500)
        .describe('Max tokens for summarization response'),

    // Auto mode settings
    autoModeTimeout: z.number().int().min(0).default(300000)
        .describe('Auto mode timeout in ms (default: 5 minutes)'),
});

const CustomProviderSchema = z.object({
    name: z.string().min(1),
    baseUrl: z.string().url(),
    apiKey: z.string().optional(),
});

/**
 * Settings that are sensitive and should NEVER be saved to disk.
 * These are only loaded from environment variables.
 */
function getSensitiveSettingKeys(): Set<string> {
    const keys = new Set<string>(['app.shellPath']);

    // Add provider-specific sensitive keys
    for (const provider of getAllProviders()) {
        if (provider.sensitiveSettingKeys) {
            for (const key of provider.sensitiveSettingKeys) {
                keys.add(key);
            }
        }
    }

    return keys;
}

const SENSITIVE_SETTING_KEYS = getSensitiveSettingKeys();

const SettingsSchema = z.object({
    providers: z.array(CustomProviderSchema).optional().default([]),
    agent: AgentSettingsSchema.optional(),
    shell: ShellSettingsSchema.optional(),
    ui: UISettingsSchema.optional(),
    logging: LoggingSettingsSchema.optional(),
    environment: EnvironmentSettingsSchema.optional(),
    app: AppSettingsSchema.optional(),
    tools: ToolsSettingsSchema.optional(),
    debug: DebugSettingsSchema.optional(),
    companion: CompanionSettingsSchema.optional(),
});

// Type definitions
export interface SettingsData {
    providers: Array<z.infer<typeof CustomProviderSchema>>;
    agent: z.infer<typeof AgentSettingsSchema>;
    shell: z.infer<typeof ShellSettingsSchema>;
    ui: z.infer<typeof UISettingsSchema>;
    logging: z.infer<typeof LoggingSettingsSchema>;
    environment: z.infer<typeof EnvironmentSettingsSchema>;
    app: z.infer<typeof AppSettingsSchema>;
    tools: z.infer<typeof ToolsSettingsSchema>;
    debug: z.infer<typeof DebugSettingsSchema>;
    companion: z.infer<typeof CompanionSettingsSchema>;
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
        temperature: SettingWithSource<number | undefined>;
        maxTurns: SettingWithSource<number>;
        retryAttempts: SettingWithSource<number>;
        provider: SettingWithSource<string>;
        openrouter: SettingWithSource<any>;
        mentorModel: SettingWithSource<string | undefined>;
        mentorReasoningEffort: SettingWithSource<string>;
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
        suppressConsoleOutput: SettingWithSource<boolean>;
    };
    environment: {
        nodeEnv: SettingWithSource<string | undefined>;
    };
    app: {
        shellPath: SettingWithSource<string | undefined>;
        mentorMode: SettingWithSource<boolean>;
        editMode: SettingWithSource<boolean>;
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
    AGENT_TEMPERATURE: 'agent.temperature',
    AGENT_PROVIDER: 'agent.provider',
    AGENT_MAX_TURNS: 'agent.maxTurns',
    AGENT_RETRY_ATTEMPTS: 'agent.retryAttempts',
    AGENT_OPENROUTER_API_KEY: 'agent.openrouter.apiKey', // Sensitive - env only
    AGENT_OPENROUTER_BASE_URL: 'agent.openrouter.baseUrl', // Sensitive - env only
    AGENT_OPENROUTER_REFERRER: 'agent.openrouter.referrer', // Sensitive - env only
    AGENT_OPENROUTER_TITLE: 'agent.openrouter.title', // Sensitive - env only
    AGENT_MENTOR_MODEL: 'agent.mentorModel',
    AGENT_MENTOR_REASONING_EFFORT: 'agent.mentorReasoningEffort',
    SHELL_TIMEOUT: 'shell.timeout',
    SHELL_MAX_OUTPUT_LINES: 'shell.maxOutputLines',
    SHELL_MAX_OUTPUT_CHARS: 'shell.maxOutputChars',
    UI_HISTORY_SIZE: 'ui.historySize',
    LOGGING_LOG_LEVEL: 'logging.logLevel',
    LOGGING_DISABLE: 'logging.disableLogging',
    LOGGING_DEBUG: 'logging.debugLogging',
    LOGGING_SUPPRESS_CONSOLE: 'logging.suppressConsoleOutput',
    ENV_NODE_ENV: 'environment.nodeEnv',
    APP_SHELL_PATH: 'app.shellPath', // Sensitive - env only
    APP_MENTOR_MODE: 'app.mentorMode',
    APP_EDIT_MODE: 'app.editMode',
    TOOLS_LOG_FILE_OPS: 'tools.logFileOperations',
    DEBUG_BASH_TOOL: 'debug.debugBashTool',
} as const;

// Define which settings are modifiable at runtime
const RUNTIME_MODIFIABLE_SETTINGS = new Set<string>([
    SETTING_KEYS.AGENT_MODEL,
    SETTING_KEYS.AGENT_REASONING_EFFORT,
    SETTING_KEYS.AGENT_TEMPERATURE,
    SETTING_KEYS.AGENT_PROVIDER,
    SETTING_KEYS.AGENT_MENTOR_MODEL,
    SETTING_KEYS.AGENT_MENTOR_REASONING_EFFORT,
    SETTING_KEYS.SHELL_TIMEOUT,
    SETTING_KEYS.SHELL_MAX_OUTPUT_LINES,
    SETTING_KEYS.SHELL_MAX_OUTPUT_CHARS,
    SETTING_KEYS.LOGGING_LOG_LEVEL,
    SETTING_KEYS.LOGGING_SUPPRESS_CONSOLE,
    SETTING_KEYS.APP_MENTOR_MODE,
    SETTING_KEYS.APP_EDIT_MODE,
]);

// Note: Sensitive settings are NOT in RUNTIME_MODIFIABLE_SETTINGS because they
// cannot be modified at all - they can only be set via environment variables at startup.

// app.mentorMode and app.editMode are runtime-modifiable AND persisted to disk so they
// survive across sessions (user's mode preference is preserved).
// Some settings with default values are optional to persist
const OPTIONAL_DEFAULT_KEYS = new Set<string>([]);

// Default settings
const DEFAULT_SETTINGS: SettingsData = {
    providers: [],
    agent: {
        model: 'gpt-5.1',
        reasoningEffort: 'default',
        maxTurns: 100,
        retryAttempts: 2,
        provider: 'openai',
        openrouter: {
            // defaults empty; can be provided via env or config
            // defaults empty; can be provided via env or config
        } as any,
        mentorModel: undefined,
        mentorReasoningEffort: 'default',
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
        suppressConsoleOutput: true,
    },
    environment: {
        nodeEnv: undefined,
    },
    app: {
        shellPath: undefined,
        mentorMode: false,
        editMode: false,
    },
    tools: {
        logFileOperations: true,
    },
    debug: {
        debugBashTool: false,
    },
    companion: {
        enabled: false,
        showHints: true,
        errorCascadeThreshold: 3,
        retryLoopThreshold: 2,
        pauseHintDelayMs: 30000,
        maxContextBufferSize: 1048576,
        maxCommandIndexSize: 10,
        summarizerModel: 'gpt-4o-mini',
        summarizerProvider: 'openai',
        summarizerMaxTokens: 500,
        autoModeTimeout: 300000,
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
    private disableFilePersistence: boolean;
    private listeners: Set<(key?: string) => void> = new Set();
    private loggingService: LoggingService;

    // Detect if running in test environment
    //
    // We intentionally use a broad set of signals because different test runners
    // set different environment variables. This prevents unit/integration tests
    // from writing to disk by default (which can cause flaky tests and polluted
    // developer machines/CI workspaces).
    private isTestEnvironment(): boolean {
        return (
            process.env.NODE_ENV === 'test' ||
            process.env.VITEST !== undefined ||
            process.env.AVA_PATH !== undefined ||
            process.env.JEST_WORKER_ID !== undefined ||
            process.env.TERM2_TEST_MODE === 'true'
        );
    }

    constructor(options?: {
        settingsDir?: string;
        disableLogging?: boolean;
        disableFilePersistence?: boolean;
        cli?: Partial<SettingsData>;
        env?: Partial<SettingsData>;
        loggingService?: LoggingService;
    }) {
        const {
            settingsDir = path.join(paths.log),
            disableLogging = false,
            disableFilePersistence,
            cli = {},
            env = {},
            loggingService,
        } = options ?? {};

        this.settingsDir = settingsDir;
        this.disableLogging = disableLogging;
        this.sources = new Map();

        // Use injected LoggingService or create a new one if not provided
        this.loggingService =
            loggingService ||
            new LoggingService({
                disableLogging: this.disableLogging,
            });

        // Disk persistence can be explicitly disabled (e.g., for tests), and is
        // also automatically disabled when running under a known test runner.
        this.disableFilePersistence =
            disableFilePersistence ?? this.isTestEnvironment();

        // Ensure settings directory exists
        if (!fs.existsSync(this.settingsDir)) {
            try {
                fs.mkdirSync(this.settingsDir, {recursive: true});
            } catch (error: any) {
                if (!this.disableLogging) {
                    this.loggingService.error(
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

        // Register any runtime-defined providers from settings.json so they appear
        // in the model selection menu and can be selected as agent.provider.
        this.registerRuntimeProviders();

        // Validate selected provider and fall back if invalid (without rejecting the
        // entire settings file).
        this.validateSelectedProvider();

        // Apply logging level from settings to the logging service so it respects settings
        try {
            this.loggingService.setLogLevel(this.settings.logging.logLevel);
            this.loggingService.setSuppressConsoleOutput(
                this.settings.logging.suppressConsoleOutput,
            );
        } catch (error: any) {
            if (!this.disableLogging) {
                this.loggingService.warn(
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
            this.loggingService.info('SettingsService initialized', {
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
            if (!this.disableFilePersistence) {
                this.saveToFile();
                if (!this.disableLogging) {
                    this.loggingService.info(
                        'Created settings file at startup',
                        {
                            settingsFile: settingsFilePath,
                        },
                    );
                }
            }
        } else if (shouldUpdateFile) {
            if (!this.disableFilePersistence) {
                this.saveToFile();
                if (!this.disableLogging) {
                    this.loggingService.info(
                        'Updated settings file with new default values',
                        {
                            settingsFile: settingsFilePath,
                        },
                    );
                }
            }
        }
    }

    private registerRuntimeProviders(): void {
        const configured = this.settings?.providers;
        if (!Array.isArray(configured) || configured.length === 0) return;

        for (const p of configured) {
            const providerId = (p as any)?.name;
            const baseUrl = (p as any)?.baseUrl;
            if (!providerId || !baseUrl) continue;

            const existing = getProvider(providerId);
            if (existing && !existing.isRuntimeDefined) {
                if (!this.disableLogging) {
                    this.loggingService.warn(
                        'Skipping custom provider because it conflicts with a built-in provider id',
                        {providerId},
                    );
                }
                continue;
            }

            try {
                upsertProvider(
                    createOpenAICompatibleProviderDefinition({
                        name: String(providerId),
                        baseUrl: String(baseUrl),
                        apiKey: (p as any)?.apiKey
                            ? String((p as any).apiKey)
                            : undefined,
                    }),
                );
            } catch (error: any) {
                if (!this.disableLogging) {
                    this.loggingService.warn(
                        'Failed to register custom provider',
                        {
                            providerId,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    );
                }
            }
        }
    }

    private validateSelectedProvider(): void {
        const current = this.settings?.agent?.provider || 'openai';
        if (getProvider(current)) return;

        if (!this.disableLogging) {
            this.loggingService.warn(
                'Configured agent.provider is not registered; falling back to openai',
                {provider: current},
            );
        }

        this.settings.agent.provider = 'openai';
        this.sources.set('agent.provider', 'default');
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
                this.loggingService.setLogLevel(value);
            } catch (err: any) {
                if (!this.disableLogging) {
                    this.loggingService.warn(
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

        if (key === 'logging.suppressConsoleOutput') {
            try {
                this.loggingService.setSuppressConsoleOutput(Boolean(value));
            } catch (err: any) {
                if (!this.disableLogging) {
                    this.loggingService.warn(
                        'Failed to update console output suppression at runtime',
                        {
                            error:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                            suppressConsoleOutput: value,
                        },
                    );
                }
            }
        }

        // Persist to file
        if (!this.disableFilePersistence) {
            this.saveToFile();
        }

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

        if (!this.disableFilePersistence) {
            this.saveToFile();
        }

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
                    this.loggingService.warn('Settings change listener threw', {
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
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
                temperature: {
                    value: this.settings.agent.temperature,
                    source: this.getSource('agent.temperature'),
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
                openrouter: {
                    value: this.settings.agent.openrouter,
                    source: this.getSource('agent.openrouter'),
                },
                mentorModel: {
                    value: this.settings.agent.mentorModel,
                    source: this.getSource('agent.mentorModel'),
                },
                mentorReasoningEffort: {
                    value: this.settings.agent.mentorReasoningEffort,
                    source: this.getSource('agent.mentorReasoningEffort'),
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
                suppressConsoleOutput: {
                    value: this.settings.logging.suppressConsoleOutput,
                    source: this.getSource('logging.suppressConsoleOutput'),
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
                mentorMode: {
                    value: this.settings.app.mentorMode,
                    source: this.getSource('app.mentorMode'),
                },
                editMode: {
                    value: this.settings.app.editMode,
                    source: this.getSource('app.editMode'),
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
                    this.loggingService.warn(
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
                this.loggingService.error('Failed to load settings file', {
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
        if (this.disableFilePersistence) {
            return;
        }

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
                    const existingContent = fs.readFileSync(
                        settingsFile,
                        'utf-8',
                    );
                    const existingParsed = JSON.parse(existingContent);

                    // Deep equality check that ignores formatting and key order
                    // Uses fast-deep-equal library for robust comparison
                    if (deepEqual(existingParsed, settingsToSave)) {
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
                this.loggingService.error('Failed to save settings file', {
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
    private stripSensitiveSettings(
        settings: SettingsData,
    ): Partial<SettingsData> {
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
            // mentorMode and editMode are persisted so they survive across sessions
        }

        return cleaned;
    }

    /**
     * Check if target object is missing any keys that exist in source
     */
    private hasMissingKeys(
        target: any,
        source: any,
        prefix: string = '',
    ): boolean {
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
            providers:
                result.providers ||
                JSON.parse(JSON.stringify(defaults.providers)),
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
            companion:
                result.companion ||
                JSON.parse(JSON.stringify(defaults.companion)),
        };

        // Validate final result
        const validated = SettingsSchema.safeParse(merged);

        if (validated.success) {
            // Ensure we return a complete SettingsData object
            return {
                providers: merged.providers,
                agent: merged.agent,
                shell: merged.shell,
                ui: merged.ui,
                logging: merged.logging,
                environment: merged.environment,
                app: merged.app,
                tools: merged.tools,
                debug: merged.debug,
                companion: merged.companion,
            };
        }

        // If validation fails, return defaults
        if (!this.disableLogging) {
            this.loggingService.warn(
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
 * Build environment-derived overrides from process.env
 * Exported for use in CLI initialization
 */
export function buildEnvOverrides(): Partial<SettingsData> {
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

/**
 * @deprecated DO NOT USE - Singleton pattern is deprecated
 *
 * This singleton is deprecated and should not be used in application code.
 * Instead, pass the SettingsService instance via dependency injection:
 *
 * - In App component: Accept as a prop from cli.tsx
 * - In services/tools: Accept via constructor deps parameter
 * - In hooks: Use a context provider or accept as parameter
 *
 * This export now throws an error when accessed to catch deprecated usage.
 * It's only allowed in test files for backwards compatibility.
 */
const _settingsServiceInstance = new SettingsService({
    env: buildEnvOverrides(),
    loggingService: new LoggingService({
        disableLogging: false,
    }),
});

const isTestEnvironment = () => {
    return (
        process.env.NODE_ENV === 'test' ||
        process.env.VITEST !== undefined ||
        process.env.AVA_PATH !== undefined ||
        process.env.JEST_WORKER_ID !== undefined ||
        process.env.TERM2_TEST_MODE === 'true'
    );
};

export const settingsService = new Proxy(_settingsServiceInstance, {
    get(target, prop) {
        // Allow access in test environment for backwards compatibility
        if (isTestEnvironment()) {
            const value = target[prop as keyof typeof target];
            // Bind methods to the original target to preserve 'this' context
            if (typeof value === 'function') {
                return value.bind(target);
            }
            return value;
        }

        // Get the caller's stack trace to show where the deprecated usage is
        const stack = new Error().stack || '';
        const callerLine = stack.split('\n')[2] || 'unknown location';

        throw new Error(
            `DEPRECATED: Direct use of settingsService singleton is not allowed.\n` +
                `Called from: ${callerLine.trim()}\n\n` +
                `Instead, pass SettingsService via dependency injection:\n` +
                `  - In App component: Accept as prop from cli.tsx\n` +
                `  - In services/tools: Accept via 'deps' constructor parameter\n` +
                `  - In hooks: Accept as parameter or use a context provider\n\n` +
                `See source/app.tsx for an example of proper dependency injection.`,
        );
    },
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
