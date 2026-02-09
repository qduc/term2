import { SettingsSchema, type SettingSource, type SettingsData } from './settings-schema.js';

type LoggerLike = {
  warn: (message: string, meta?: any) => void;
};

/**
 * Flatten nested object to dot notation.
 */
export function flattenSettings(obj: any, prefix = ''): Record<string, any> {
  const result: Record<string, any> = {};

  for (const key in obj) {
    if (!obj.hasOwnProperty(key)) continue;

    const value = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenSettings(value, newKey));
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Deep merge source into target (mutates target).
 */
export function deepMerge(target: any, source: any): void {
  for (const key in source) {
    if (!source.hasOwnProperty(key)) continue;

    const sourceValue = source[key];

    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }

      deepMerge(target[key], sourceValue);
    } else {
      target[key] = sourceValue;
    }
  }
}

/**
 * Merge multiple settings sources with proper precedence.
 * Precedence: cli > env > config > defaults.
 */
export function mergeSettings(
  defaults: SettingsData,
  fileConfig: Partial<SettingsData>,
  env: Partial<SettingsData>,
  cli: Partial<SettingsData>,
  opts?: {
    disableLogging?: boolean;
    loggingService?: LoggerLike;
  },
): SettingsData {
  // Deep merge starting with defaults
  const result = JSON.parse(JSON.stringify(defaults));

  // Merge file config
  deepMerge(result, fileConfig);

  // Merge env
  deepMerge(result, env);

  // Merge cli (highest priority)
  deepMerge(result, cli);

  // Ensure all required fields are present
  const merged: SettingsData = {
    providers: result.providers || JSON.parse(JSON.stringify(defaults.providers)),
    agent: result.agent || JSON.parse(JSON.stringify(defaults.agent)),
    shell: result.shell || JSON.parse(JSON.stringify(defaults.shell)),
    ui: result.ui || JSON.parse(JSON.stringify(defaults.ui)),
    logging: result.logging || JSON.parse(JSON.stringify(defaults.logging)),
    environment: result.environment || JSON.parse(JSON.stringify(defaults.environment)),
    app: result.app || JSON.parse(JSON.stringify(defaults.app)),
    tools: result.tools || JSON.parse(JSON.stringify(defaults.tools)),
    debug: result.debug || JSON.parse(JSON.stringify(defaults.debug)),
    ssh: result.ssh || JSON.parse(JSON.stringify(defaults.ssh)),
    webSearch: result.webSearch || JSON.parse(JSON.stringify(defaults.webSearch)),
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
      ssh: merged.ssh,
      webSearch: merged.webSearch,
    };
  }

  // If validation fails, return defaults
  if (!opts?.disableLogging) {
    opts?.loggingService?.warn('Final merged settings failed validation, using defaults', {
      errors: validated.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return defaults;
}

/**
 * Track the source of each setting key.
 */
export function trackSettingSources(
  defaults: SettingsData,
  fileConfig: Partial<SettingsData>,
  env: Partial<SettingsData>,
  cli: Partial<SettingsData>,
): Map<string, SettingSource> {
  const sources = new Map<string, SettingSource>();

  const flatDefaults = flattenSettings(defaults);
  const flatFileConfig = flattenSettings(fileConfig);
  const flatEnv = flattenSettings(env);
  const flatCli = flattenSettings(cli);

  // For each possible setting key, determine its source
  for (const key in flatDefaults) {
    if (flatCli.hasOwnProperty(key)) {
      sources.set(key, 'cli');
    } else if (flatEnv.hasOwnProperty(key)) {
      sources.set(key, 'env');
    } else if (flatFileConfig.hasOwnProperty(key)) {
      sources.set(key, 'config');
    } else {
      sources.set(key, 'default');
    }
  }

  return sources;
}
