import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { LoggingService } from './logging-service.js';
import { getProvider, upsertProvider } from '../providers/index.js';
import { createOpenAICompatibleProviderDefinition } from '../providers/openai-compatible.provider.js';
import {
  DEFAULT_SETTINGS,
  OPTIONAL_DEFAULT_KEYS,
  RUNTIME_MODIFIABLE_SETTINGS,
  SENSITIVE_SETTING_KEYS,
  SettingsSchema,
  type SettingSource,
  type SettingsData,
  type SettingsWithSources,
} from './settings-schema.js';
import { buildEnvOverrides, isTestEnvironment, parseBooleanEnv } from './settings-env.js';
import { flattenSettings, mergeSettings, trackSettingSources } from './settings-merger.js';
import {
  hasMissingKeys,
  loadSettingsFromFile,
  saveSettingsToFile,
  stripSensitiveSettings,
} from './settings-persistence.js';

const paths = envPaths('term2');

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

    const resolvedDisableLogging = disableLogging || parseBooleanEnv(process.env.DISABLE_LOGGING);

    this.settingsDir = settingsDir;
    this.disableLogging = resolvedDisableLogging;
    this.sources = new Map();

    // Use injected LoggingService or create a new one if not provided
    this.loggingService =
      loggingService ||
      new LoggingService({
        disableLogging: this.disableLogging,
      });

    // Disk persistence can be explicitly disabled (e.g., for tests), and is
    // also automatically disabled when running under a known test runner.
    this.disableFilePersistence = disableFilePersistence ?? isTestEnvironment();

    // Ensure settings directory exists
    if (!fs.existsSync(this.settingsDir)) {
      try {
        fs.mkdirSync(this.settingsDir, { recursive: true });
      } catch (error: any) {
        if (!this.disableLogging) {
          this.loggingService.error('Failed to create settings directory', {
            error: error instanceof Error ? error.message : String(error),
            path: this.settingsDir,
          });
        }
      }
    }

    // Load settings with precedence: CLI > Env > Config > Default
    const settingsFilePath = path.join(this.settingsDir, 'settings.json');
    const configFileExisted = fs.existsSync(settingsFilePath);
    const { validated: fileConfig, raw: rawFileConfig } = this.loadFromFile();
    this.settings = mergeSettings(DEFAULT_SETTINGS, fileConfig, env, cli, {
      disableLogging: this.disableLogging,
      loggingService: this.loggingService,
    });
    this.sources = trackSettingSources(DEFAULT_SETTINGS, fileConfig, env, cli);

    // Register any runtime-defined providers from settings.json so they appear
    // in the model selection menu and can be selected as agent.provider.
    this.registerRuntimeProviders();

    // Validate selected provider and fall back if invalid (without rejecting the
    // entire settings file).
    this.validateSelectedProvider();

    // Apply logging level from settings to the logging service so it respects settings
    try {
      this.loggingService.setLogLevel(this.settings.logging.logLevel);
      this.loggingService.setSuppressConsoleOutput(this.settings.logging.suppressConsoleOutput);
    } catch (error: any) {
      if (!this.disableLogging) {
        this.loggingService.warn('Failed to apply logging level from settings', {
          error: error instanceof Error ? error.message : String(error),
          loggingLevel: this.settings.logging.logLevel,
        });
      }
    }

    if (!this.disableLogging) {
      this.loggingService.info('SettingsService initialized', {
        cliOverrides: Object.keys(flattenSettings(cli)).length > 0,
        envOverrides: Object.keys(flattenSettings(env)).length > 0,
        configOverrides: Object.keys(flattenSettings(fileConfig)).length > 0,
      });
    }

    // Check if file config is missing any keys that exist in defaults
    // Use raw file config (pre-Zod) to detect missing keys since Zod adds defaults
    const shouldUpdateFile = configFileExisted && this.hasMissingKeys(rawFileConfig, DEFAULT_SETTINGS);

    // If there was no config file on disk, persist the current merged settings so
    // users get a settings.json created at startup (rather than waiting for a
    // manual change). saveToFile is safe and handles errors/logging internally.
    // Also update the file if new settings have been added since the file was created.
    if (!configFileExisted) {
      if (!this.disableFilePersistence) {
        this.saveToFile();
        if (!this.disableLogging) {
          this.loggingService.info('Created settings file at startup', {
            settingsFile: settingsFilePath,
          });
        }
      }
    } else if (shouldUpdateFile) {
      if (!this.disableFilePersistence) {
        this.saveToFile();
        if (!this.disableLogging) {
          this.loggingService.info('Updated settings file with new default values', {
            settingsFile: settingsFilePath,
          });
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
          this.loggingService.warn('Skipping custom provider because it conflicts with a built-in provider id', {
            providerId,
          });
        }
        continue;
      }

      try {
        upsertProvider(
          createOpenAICompatibleProviderDefinition({
            name: String(providerId),
            baseUrl: String(baseUrl),
            apiKey: (p as any)?.apiKey ? String((p as any).apiKey) : undefined,
          }),
        );
      } catch (error: any) {
        if (!this.disableLogging) {
          this.loggingService.warn('Failed to register custom provider', {
            providerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private validateSelectedProvider(): void {
    const current = this.settings?.agent?.provider || 'openai';
    if (getProvider(current)) return;

    if (!this.disableLogging) {
      this.loggingService.warn('Configured agent.provider is not registered; falling back to openai', {
        provider: current,
      });
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
      throw new Error(`Cannot modify '${key}' at runtime. Requires restart.`);
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
          this.loggingService.warn('Failed to update logging level at runtime', {
            error: err instanceof Error ? err.message : String(err),
            loggingLevel: value,
          });
        }
      }
    }

    if (key === 'logging.suppressConsoleOutput') {
      try {
        this.loggingService.setSuppressConsoleOutput(Boolean(value));
      } catch (err: any) {
        if (!this.disableLogging) {
          this.loggingService.warn('Failed to update console output suppression at runtime', {
            error: err instanceof Error ? err.message : String(err),
            suppressConsoleOutput: value,
          });
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
        mentorProvider: {
          value: this.settings.agent.mentorProvider,
          source: this.getSource('agent.mentorProvider'),
        },
        mentorReasoningEffort: {
          value: this.settings.agent.mentorReasoningEffort,
          source: this.getSource('agent.mentorReasoningEffort'),
        },
        useFlexServiceTier: {
          value: this.settings.agent.useFlexServiceTier,
          source: this.getSource('agent.useFlexServiceTier'),
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
        liteMode: {
          value: this.settings.app.liteMode,
          source: this.getSource('app.liteMode'),
        },
      },
      tools: {
        logFileOperations: {
          value: this.settings.tools.logFileOperations,
          source: this.getSource('tools.logFileOperations'),
        },
        enableEditHealing: {
          value: this.settings.tools.enableEditHealing,
          source: this.getSource('tools.enableEditHealing'),
        },
        editHealingModel: {
          value: this.settings.tools.editHealingModel,
          source: this.getSource('tools.editHealingModel'),
        },
      },
      debug: {
        debugBashTool: {
          value: this.settings.debug.debugBashTool,
          source: this.getSource('debug.debugBashTool'),
        },
      },
      ssh: {
        enabled: {
          value: this.settings.ssh.enabled,
          source: this.getSource('ssh.enabled'),
        },
        host: {
          value: this.settings.ssh.host,
          source: this.getSource('ssh.host'),
        },
        port: {
          value: this.settings.ssh.port,
          source: this.getSource('ssh.port'),
        },
        username: {
          value: this.settings.ssh.username,
          source: this.getSource('ssh.username'),
        },
        remoteDir: {
          value: this.settings.ssh.remoteDir,
          source: this.getSource('ssh.remoteDir'),
        },
      },
      webSearch: {
        provider: {
          value: this.settings.webSearch?.provider,
          source: this.getSource('webSearch.provider'),
        },
        tavily: {
          value: this.settings.webSearch?.tavily,
          source: this.getSource('webSearch.tavily'),
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
    return loadSettingsFromFile({
      settingsDir: this.settingsDir,
      schema: SettingsSchema,
      disableLogging: this.disableLogging,
      loggingService: this.loggingService,
    });
  }

  /**
   * Save settings to file, excluding sensitive values
   */
  private saveToFile(): void {
    if (this.disableFilePersistence) {
      return;
    }
    saveSettingsToFile({
      settingsDir: this.settingsDir,
      settings: this.settings,
      stripSensitiveSettings,
      disableLogging: this.disableLogging,
      loggingService: this.loggingService,
    });
  }

  /**
   * Check if target object is missing any keys that exist in source
   */
  private hasMissingKeys(target: any, source: any, prefix: string = ''): boolean {
    return hasMissingKeys(target, source, OPTIONAL_DEFAULT_KEYS, prefix);
  }
}

export { buildEnvOverrides } from './settings-env.js';

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
    disableLogging: parseBooleanEnv(process.env.DISABLE_LOGGING) || isTestEnvironment(),
    debugLogging: parseBooleanEnv(process.env.DEBUG_LOGGING),
  }),
});

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

export { SETTING_KEYS, SENSITIVE_SETTINGS } from './settings-schema.js';
export type { SettingsData, SettingSource, SettingWithSource, SettingsWithSources } from './settings-schema.js';
