import fs from 'node:fs';
import path from 'node:path';
import envPaths from 'env-paths';
import { LoggingService } from '../logging/logging-service.js';
import { getProvider, upsertProvider } from '../../providers/registry.js';
import { createOpenAICompatibleProviderDefinition } from '../../providers/openai-compatible-lazy.js';
import { resolveProviderId, resolveProviderName } from './custom-provider-normalization.js';
import {
  DEFAULT_SETTINGS,
  OPTIONAL_DEFAULT_KEYS,
  RUNTIME_MODIFIABLE_SETTINGS,
  SENSITIVE_SETTING_KEYS,
  SettingsSchema,
  normalizeAppModes,
  type SettingSource,
  type SettingsData,
  type SettingsWithSources,
} from './settings-schema.js';
import { isTestEnvironment, parseBooleanEnv } from './settings-env.js';
import { flattenSettings, mergeSettings, trackSettingSources } from './settings-merger.js';
import { buildSettingsWithSources } from './settings-sources.js';
import { migrateLegacyAncillarySettings } from './ancillary-settings-migration.js';
import {
  hasMissingKeys,
  loadSettingsFromFile,
  saveSettingsToFile,
  stripSensitiveSettings,
} from './settings-persistence.js';

const paths = envPaths('term2');

function cloneSettingValue<T>(value: T): T {
  if (value == null || typeof value !== 'object') {
    return value;
  }

  return structuredClone(value);
}

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
    const { validated, raw: rawFileConfig, hadErrors: fileHadErrors } = this.loadFromFile();
    const { config: fileConfig, migrated: migratedLegacyAncillarySettings } = migrateLegacyAncillarySettings(
      validated,
      rawFileConfig,
    );
    this.settings = mergeSettings(DEFAULT_SETTINGS, fileConfig, env, cli, {
      disableLogging: this.disableLogging,
      loggingService: this.loggingService,
    });
    this.sources = trackSettingSources(DEFAULT_SETTINGS, fileConfig, env, cli);

    // Normalize exclusive app modes so conflicting persisted state is resolved
    // on load, not lazily at first set() call.
    {
      const app = this.settings.app ?? {};
      const normalized = normalizeAppModes({
        orchestratorMode: app.orchestratorMode ?? false,
        liteMode: app.liteMode ?? false,
        planMode: app.planMode ?? false,
        mentorMode: app.mentorMode ?? false,
      });
      this.settings.app = { ...app, ...normalized };
    }

    // Register any runtime-defined providers from settings.json so they appear
    // in the model selection menu and can be selected as agent.provider.
    this.registerRuntimeProviders();

    // Migrate legacy selected provider values (for example values with spaces)
    // to the normalized provider id form before validation fallback runs.
    this.migrateSelectedProviderId();

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
      this.loggingService.debug('SettingsService initialized', {
        cliOverrides: Object.keys(flattenSettings(cli)).length > 0,
        envOverrides: Object.keys(flattenSettings(env)).length > 0,
        configOverrides: Object.keys(flattenSettings(fileConfig)).length > 0,
      });
    }

    // Check if file config is missing any keys that exist in defaults
    // Use raw file config (pre-Zod) to detect missing keys since Zod adds defaults
    const shouldUpdateFile = configFileExisted && this.hasMissingKeys(rawFileConfig, DEFAULT_SETTINGS);
    const shouldMigrateLegacyProviderFormat = configFileExisted && this.hasLegacyProviderFormat(rawFileConfig);

    // If there was no config file on disk, persist the current merged settings so
    // users get a settings.json created at startup (rather than waiting for a
    // manual change). saveToFile is safe and handles errors/logging internally.
    // Also update the file if new settings have been added since the file was created.
    if (!configFileExisted) {
      if (!this.disableFilePersistence) {
        this.saveToFile();
        if (!this.disableLogging) {
          this.loggingService.debug('Created settings file at startup', {
            settingsFile: settingsFilePath,
          });
        }
      }
    } else if (
      (shouldUpdateFile || shouldMigrateLegacyProviderFormat || migratedLegacyAncillarySettings) &&
      !fileHadErrors
    ) {
      if (!this.disableFilePersistence) {
        this.saveToFile();
        if (!this.disableLogging) {
          this.loggingService.debug('Updated settings file with defaults and/or migrations', {
            settingsFile: settingsFilePath,
            updatedMissingDefaults: shouldUpdateFile,
            migratedLegacyProviders: shouldMigrateLegacyProviderFormat,
            migratedLegacyAncillarySettings,
          });
        }
      }
    }
  }

  private hasLegacyProviderFormat(rawFileConfig: any): boolean {
    const providers = rawFileConfig?.providers;
    if (!Array.isArray(providers)) return false;

    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') {
        continue;
      }

      const hasId = typeof (provider as any).id === 'string' && (provider as any).id.trim().length > 0;
      if (!hasId) {
        return true;
      }
    }

    return false;
  }

  private registerRuntimeProviders(): void {
    const configured = this.settings?.providers;
    if (!Array.isArray(configured) || configured.length === 0) return;

    for (const p of configured) {
      const providerId = resolveProviderId(p);
      if (!providerId) continue;
      const baseUrl = (p as any)?.baseUrl;
      const providerType = String((p as any)?.type || '');
      const providerName = resolveProviderName(p, providerId);
      const baseUrlOptional = providerType === 'anthropic' || providerType === 'google' || providerType === 'opencode';
      if (!providerId || (!baseUrl && !baseUrlOptional)) continue;

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
            label: providerName,
            type: (p as any)?.type ? String((p as any).type) : 'openai-compatible',
            baseUrl: baseUrl ? String(baseUrl) : undefined,
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

  private migrateSelectedProviderId(): void {
    const current = this.settings?.agent?.provider;
    if (!current || typeof current !== 'string') {
      return;
    }

    if (getProvider(current)) {
      return;
    }

    const normalized = resolveProviderId({ name: current });
    if (!normalized || normalized === current) {
      return;
    }

    if (!getProvider(normalized)) {
      return;
    }

    this.settings.agent.provider = normalized;
    this.sources.set('agent.provider', 'config');
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

  private validateAndApplySetting(key: string, value: any): void {
    const nextSettings = structuredClone(this.settings);
    const keys = key.split('.');
    let obj: any = nextSettings;

    for (let i = 0; i < keys.length - 1; i++) {
      if (!obj[keys[i]]) {
        obj[keys[i]] = {};
      }

      obj = obj[keys[i]];
    }

    obj[keys[keys.length - 1]] = value;

    const result = SettingsSchema.safeParse(nextSettings);
    if (!result.success) {
      const matchingIssue = result.error.issues.find((issue) => issue.path.join('.') === key) ?? result.error.issues[0];
      const issuePath = matchingIssue?.path?.join('.') || key;
      const issueMessage = matchingIssue?.message || 'Invalid setting value';
      throw new Error(`Invalid value for '${issuePath}': ${issueMessage}`);
    }

    this.settings = result.data as SettingsData;
    this.validateSelectedProvider();
  }

  private normalizeExclusiveAppModes(key: string, value: any): void {
    if (
      !key.startsWith('app.') ||
      (key !== 'app.orchestratorMode' &&
        key !== 'app.liteMode' &&
        key !== 'app.planMode' &&
        key !== 'app.mentorMode') ||
      value !== true
    ) {
      return;
    }

    const app = this.settings.app ?? {};
    this.settings.app = {
      ...app,
      orchestratorMode: key === 'app.orchestratorMode',
      liteMode: key === 'app.liteMode',
      planMode: key === 'app.planMode',
      mentorMode: key === 'app.mentorMode',
    };
  }

  /**
   * Set a setting value (runtime modification)
   * Only runtime-modifiable settings can be changed.
   * Sensitive settings cannot be modified (must come from environment).
   */
  set(key: string, value: any, options?: { persist?: boolean }): void {
    if (this.isSensitive(key)) {
      throw new Error(
        `Cannot modify '${key}' - it is a sensitive setting that can only be configured via environment variables.`,
      );
    }

    if (!this.isRuntimeModifiable(key)) {
      throw new Error(`Cannot modify '${key}' at runtime. Requires restart.`);
    }

    this.validateAndApplySetting(key, value);
    this.normalizeExclusiveAppModes(key, value);

    // Track source as 'cli' for runtime-set values
    this.sources.set(key, 'cli');

    // Enforce exclusive app mode invariants. When one mode is enabled, all
    // sibling modes are cleared.  This is the single enforcement point so
    // that neither slash-command handlers nor direct set() calls can bypass
    // mutual exclusion.  (normalizeAppModes implements the precedence.)
    if (
      key.startsWith('app.') &&
      (key === 'app.orchestratorMode' || key === 'app.liteMode' || key === 'app.planMode' || key === 'app.mentorMode')
    ) {
      if (value === true) {
        for (const modeKey of ['app.orchestratorMode', 'app.liteMode', 'app.planMode', 'app.mentorMode'] as const) {
          if (modeKey !== key) {
            this.sources.set(modeKey, 'cli');
          }
        }
      }
    }

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

    // Persist to file unless the caller explicitly opts out
    const persist = options?.persist !== false;
    if (persist && !this.disableFilePersistence) {
      this.saveToFile();
    }

    this.notifyChange(key);
  }

  /**
   * Persist a setting even if it only takes effect after restart.
   * This still validates against the full schema and updates in-memory state
   * so the settings UI reflects the saved value immediately.
   */
  setPersistent(key: string, value: any): void {
    if (this.isSensitive(key)) {
      throw new Error(
        `Cannot modify '${key}' - it is a sensitive setting that can only be configured via environment variables.`,
      );
    }

    this.validateAndApplySetting(key, value);
    this.normalizeExclusiveAppModes(key, value);

    this.sources.set(key, 'cli');

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

      obj[lastKey] = cloneSettingValue(defaultValue);
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
    return buildSettingsWithSources(this.settings, (key) => this.getSource(key));
  }

  /**
   * Load settings from file
   * Returns both raw (pre-Zod) and validated data
   */
  private loadFromFile(): {
    validated: Partial<SettingsData>;
    raw: any;
    hadErrors: boolean;
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

export { SETTING_KEYS, SENSITIVE_SETTINGS } from './settings-schema.js';
export type { SettingsData, SettingSource, SettingWithSource, SettingsWithSources } from './settings-schema.js';
