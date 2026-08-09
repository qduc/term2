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
  type SettingKey,
  type SettingSource,
  type SettingValue,
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

function setSettingValue(target: Record<string, any>, key: string, value: unknown): void {
  const parts = key.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = cloneSettingValue(value);
}

function changedSettingPaths(before: unknown, after: unknown, prefix = ''): Array<[string, unknown]> {
  if (Object.is(before, after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const beforeRecord = before as Record<string, unknown>;
    const afterRecord = after as Record<string, unknown>;
    const paths: Array<[string, unknown]> = [];
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      paths.push(...changedSettingPaths(beforeRecord[key], afterRecord[key], prefix ? `${prefix}.${key}` : key));
    }
    return paths;
  }
  return prefix ? [[prefix, after]] : [];
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
  private startupMigrations: Array<[string, unknown]> = [];
  private startupEnv: Partial<SettingsData> = {};
  private startupCli: Partial<SettingsData> = {};
  private runtimeOverrides = new Map<string, unknown>();
  private runtimeOverrideSources = new Map<string, SettingSource>();
  private resetAllAtRuntime = false;

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
    this.startupEnv = structuredClone(env);
    this.startupCli = structuredClone(cli);

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
    const { validated, raw: rawFileConfig, hadErrors: fileHadErrors, errorDetails } = this.loadFromFile();

    if (configFileExisted && fileHadErrors) {
      const details = errorDetails && errorDetails.length > 0 ? `:\n  - ${errorDetails.join('\n  - ')}` : '';
      throw new Error(`Failed to parse settings file at ${settingsFilePath}${details}`);
    }

    const { config: fileConfig, migrated: migratedLegacyAncillarySettings } = migrateLegacyAncillarySettings(
      validated,
      rawFileConfig,
    );
    if (migratedLegacyAncillarySettings) {
      this.startupMigrations = changedSettingPaths(validated, fileConfig);
    }
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

    // Normalize sandbox / auto-approve exclusivity on load: 'always' mode
    // cannot coexist with an enabled sandbox (it auto-approves the unsandboxed
    // escape the sandbox exists to gate), so a persisted conflict is demoted
    // to 'auto' up front and flagged instead of silently surviving a restart.
    // When the conflict comes from the settings file, the demotion is recorded
    // as a startup migration so the file is rewritten once and the conflict
    // cannot be resurrected by a later reconcile.
    let normalizedSandboxAutoApproveConflict = false;
    if (this.settings.sandbox?.enabled === true && this.settings.shell?.autoApproveMode === 'always') {
      this.settings.shell.autoApproveMode = 'auto';
      this.sources.set('shell.autoApproveMode', 'config');
      if (fileConfig.shell?.autoApproveMode === 'always' && (fileConfig.sandbox?.enabled ?? true) === true) {
        this.startupMigrations.push(['shell.autoApproveMode', 'auto']);
        normalizedSandboxAutoApproveConflict = true;
      }
      if (!this.disableLogging) {
        this.loggingService.warn(
          'shell.autoApproveMode "always" conflicts with sandbox.enabled=true; demoted mode to "auto"',
          { settingsFile: settingsFilePath },
        );
      }
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
    if (shouldMigrateLegacyProviderFormat) {
      this.startupMigrations.push(['providers', fileConfig.providers]);
    }

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
      (shouldUpdateFile ||
        shouldMigrateLegacyProviderFormat ||
        migratedLegacyAncillarySettings ||
        normalizedSandboxAutoApproveConflict) &&
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
   * Get a setting value by typed dot-notation key (e.g., 'agent.model')
   */
  get<K extends SettingKey>(key: K): SettingValue<K> {
    return this.getDynamic(key) as SettingValue<K>;
  }

  /**
   * Get a setting value by arbitrary dynamic key path, returning unknown.
   */
  getDynamic(key: string): unknown {
    const keys = key.split('.');
    let value: any = this.settings;

    for (const k of keys) {
      if (value && typeof value === 'object') {
        value = value[k];
      } else {
        return undefined;
      }
    }

    return value;
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
   * Enforce sandbox / auto-approve exclusivity: 'always' auto-approval cannot
   * coexist with an enabled sandbox. Setting the mode to 'always' disables the
   * sandbox; enabling the sandbox while the mode is 'always' demotes the mode
   * to 'auto'. Returns the coupled key when a normalization was applied, so
   * callers can notify listeners for it (the status bar reads both settings).
   */
  private normalizeSandboxAutoApproveExclusivity(key: string, value: unknown): string | undefined {
    if (key === 'shell.autoApproveMode' && value === 'always') {
      this.settings.sandbox.enabled = false;
      this.sources.set('sandbox.enabled', 'cli');
      return 'sandbox.enabled';
    }
    if (key === 'sandbox.enabled' && value === true && this.settings.shell.autoApproveMode === 'always') {
      this.settings.shell.autoApproveMode = 'auto';
      this.sources.set('shell.autoApproveMode', 'cli');
      return 'shell.autoApproveMode';
    }
    return undefined;
  }

  /**
   * Set a setting value (runtime modification)
   * Only runtime-modifiable settings can be changed.
   * Sensitive settings cannot be modified (must come from environment).
   */
  set<K extends SettingKey>(key: K, value: SettingValue<K>, options?: { persist?: boolean }): void {
    this.setDynamic(key, value, options);
  }

  setDynamic(key: string, value: unknown, options?: { persist?: boolean }): void {
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

    this.recordRuntimeOverride(key, value, 'cli');

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

    // Same single-enforcement-point treatment for the sandbox / auto-approve
    // pair. Must run after recordRuntimeOverride so that method can read the
    // pre-normalization mode for its own override-map handling.
    const coupledKey = this.normalizeSandboxAutoApproveExclusivity(key, value);

    // If we're changing the logging level, update the logging service runtime
    if (key === 'logging.logLevel') {
      try {
        this.loggingService.setLogLevel(value as any);
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
      this.saveToFile((current) => this.applyPersistedSetting(current, key, value));
    }

    this.notifyChange(key);
    if (coupledKey) {
      this.notifyChange(coupledKey);
    }
  }

  /**
   * Validate all runtime changes before applying any of them. This is the
   * transaction boundary used by conversation configuration: a multi-field
   * model/provider selection must not leave settings half-applied when one
   * field is invalid.
   */
  setDynamicTransaction(changes: readonly { key: string; value: unknown }[]): void {
    if (changes.length === 0) return;

    const candidate = structuredClone(this.settings) as SettingsData;
    for (const change of changes) {
      if (this.isSensitive(change.key)) {
        throw new Error(
          `Cannot modify '${change.key}' - it is a sensitive setting that can only be configured via environment variables.`,
        );
      }
      if (!this.isRuntimeModifiable(change.key)) {
        throw new Error(`Cannot modify '${change.key}' at runtime. Requires restart.`);
      }
      setSettingValue(candidate as unknown as Record<string, any>, change.key, change.value);
      if (
        change.key.startsWith('app.') &&
        (change.key === 'app.orchestratorMode' ||
          change.key === 'app.liteMode' ||
          change.key === 'app.planMode' ||
          change.key === 'app.mentorMode') &&
        change.value === true
      ) {
        candidate.app = {
          ...candidate.app,
          orchestratorMode: change.key === 'app.orchestratorMode',
          liteMode: change.key === 'app.liteMode',
          planMode: change.key === 'app.planMode',
          mentorMode: change.key === 'app.mentorMode',
        };
      }
    }

    const result = SettingsSchema.safeParse(candidate);
    if (!result.success) {
      const issue = result.error.issues[0];
      const issuePath = issue?.path.join('.') || changes[0]!.key;
      throw new Error(`Invalid value for '${issuePath}': ${issue?.message || 'Invalid setting value'}`);
    }

    for (const change of changes) {
      this.setDynamic(change.key, change.value);
    }
  }

  /**
   * Persist a setting even if it only takes effect after restart.
   * This still validates against the full schema and updates in-memory state
   * so the settings UI reflects the saved value immediately.
   */
  setPersistent<K extends SettingKey>(key: K, value: SettingValue<K>): void {
    this.setPersistentDynamic(key, value);
  }

  setPersistentDynamic(key: string, value: unknown): void {
    if (this.isSensitive(key)) {
      throw new Error(
        `Cannot modify '${key}' - it is a sensitive setting that can only be configured via environment variables.`,
      );
    }

    this.validateAndApplySetting(key, value);
    this.normalizeExclusiveAppModes(key, value);

    this.recordRuntimeOverride(key, value, 'cli');

    this.sources.set(key, 'cli');

    const coupledKey = this.normalizeSandboxAutoApproveExclusivity(key, value);

    if (!this.disableFilePersistence) {
      this.saveToFile((current) => this.applyPersistedSetting(current, key, value));
    }

    this.notifyChange(key);
    if (coupledKey) {
      this.notifyChange(coupledKey);
    }
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

    let coupledKey: string | undefined;

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
      this.recordRuntimeOverride(key, defaultValue, 'default');
      coupledKey = this.normalizeSandboxAutoApproveExclusivity(key, defaultValue);
    } else {
      // Reset all settings
      this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
      this.sources.clear();
      this.resetAllAtRuntime = true;
      this.runtimeOverrides.clear();
      this.runtimeOverrideSources.clear();
    }

    if (!this.disableFilePersistence) {
      this.saveToFile((current) => {
        if (!key) return structuredClone(DEFAULT_SETTINGS);
        return this.applyPersistedSetting(current, key, this.defaultValueFor(key));
      });
    }

    this.notifyChange(key);
    if (key && coupledKey) {
      this.notifyChange(coupledKey);
    }
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
    errorDetails?: string[];
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
  private defaultValueFor(key: string): unknown {
    let value: unknown = DEFAULT_SETTINGS;
    for (const part of key.split('.')) {
      value = (value as Record<string, unknown>)[part];
    }
    return cloneSettingValue(value);
  }

  private applyPersistedSetting(current: SettingsData, key: string, value: unknown): SettingsData {
    const next = structuredClone(current) as Record<string, any>;
    setSettingValue(next, key, value);

    if (
      key === 'app.orchestratorMode' ||
      key === 'app.liteMode' ||
      key === 'app.planMode' ||
      key === 'app.mentorMode'
    ) {
      next.app =
        value === true
          ? {
              ...next.app,
              orchestratorMode: key === 'app.orchestratorMode',
              liteMode: key === 'app.liteMode',
              planMode: key === 'app.planMode',
              mentorMode: key === 'app.mentorMode',
            }
          : {
              ...next.app,
              ...normalizeAppModes({
                orchestratorMode: next.app?.orchestratorMode ?? false,
                liteMode: next.app?.liteMode ?? false,
                planMode: next.app?.planMode ?? false,
                mentorMode: next.app?.mentorMode ?? false,
              }),
            };
    }

    // Sandbox / auto-approve exclusivity in the persisted copy, mirroring the
    // app-mode block above: writing one side must normalize the other side in
    // the file so a stale service cannot commit the conflicting pair.
    if (key === 'shell.autoApproveMode' && value === 'always') {
      setSettingValue(next, 'sandbox.enabled', false);
    } else if (key === 'sandbox.enabled' && value === true && current.shell?.autoApproveMode === 'always') {
      setSettingValue(next, 'shell.autoApproveMode', 'auto');
    }

    return SettingsSchema.parse(next) as SettingsData;
  }

  private recordRuntimeOverride(key: string, value: unknown, source: SettingSource): void {
    this.resetAllAtRuntime = false;
    this.runtimeOverrides.set(key, cloneSettingValue(value));
    this.runtimeOverrideSources.set(key, source);
    if (value === true && key.startsWith('app.')) {
      for (const modeKey of ['app.orchestratorMode', 'app.liteMode', 'app.planMode', 'app.mentorMode']) {
        if (modeKey !== key) {
          this.runtimeOverrides.set(modeKey, false);
          this.runtimeOverrideSources.set(modeKey, 'cli');
        }
      }
    }
    // Sandbox / auto-approve exclusivity, mirroring the app-mode block: the
    // runtime override map must stay consistent with the normalized in-memory
    // state so a later reconciliation cannot resurrect the conflict. Rule B
    // reads this.settings because normalization runs after this method.
    if (key === 'shell.autoApproveMode' && value === 'always') {
      this.runtimeOverrides.set('sandbox.enabled', false);
      this.runtimeOverrideSources.set('sandbox.enabled', source);
    } else if (key === 'sandbox.enabled' && value === true && this.settings.shell.autoApproveMode === 'always') {
      this.runtimeOverrides.set('shell.autoApproveMode', 'auto');
      this.runtimeOverrideSources.set('shell.autoApproveMode', source);
    }
  }

  private reconcileCommittedSettings(committed: SettingsData): void {
    if (this.resetAllAtRuntime) {
      this.settings = structuredClone(DEFAULT_SETTINGS);
      this.sources.clear();
      return;
    }

    let next = mergeSettings(DEFAULT_SETTINGS, committed, this.startupEnv, this.startupCli, {
      disableLogging: this.disableLogging,
      loggingService: this.loggingService,
    });
    for (const [key, value] of this.runtimeOverrides) {
      next = this.applyPersistedSetting(next, key, value);
    }
    this.settings = next;
    this.sources = trackSettingSources(DEFAULT_SETTINGS, committed, this.startupEnv, this.startupCli);
    for (const [key, source] of this.runtimeOverrideSources) {
      this.sources.set(key, source);
    }
  }

  private applyStartupChanges(current: SettingsData): SettingsData {
    const next = structuredClone(current) as Record<string, any>;
    for (const [key, value] of this.startupMigrations) {
      setSettingValue(next, key, value);
    }
    return next as SettingsData;
  }

  private saveToFile(mutate?: (current: SettingsData) => SettingsData): void {
    if (this.disableFilePersistence) {
      return;
    }
    const committed = saveSettingsToFile({
      settingsDir: this.settingsDir,
      schema: SettingsSchema,
      defaults: DEFAULT_SETTINGS,
      mutate: (current) => {
        return mutate ? mutate(current) : this.applyStartupChanges(current);
      },
      stripSensitiveSettings,
      disableLogging: this.disableLogging,
      loggingService: this.loggingService,
    });
    if (committed) {
      this.reconcileCommittedSettings(committed);
    }
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
