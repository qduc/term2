import { SettingsSchema, type SettingSource, type SettingsData } from './settings-schema.js';
import type { DeepPartial } from './settings-env.js';

type LoggerLike = {
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

/**
 * Flatten nested object to dot notation.
 */
export function flattenSettings(obj: unknown, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return result;

  const record = obj as Record<string, unknown>;

  for (const key in record) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) continue;

    const value = record[key];
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
export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;

    const sourceValue = source[key];

    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }

      deepMerge(target[key] as Record<string, unknown>, sourceValue as Record<string, unknown>);
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
  fileConfig: DeepPartial<SettingsData>,
  env: DeepPartial<SettingsData>,
  cli: DeepPartial<SettingsData>,
  opts?: {
    disableLogging?: boolean;
    loggingService?: LoggerLike;
  },
): SettingsData {
  // Deep merge starting with defaults
  const result = JSON.parse(JSON.stringify(defaults)) as Record<string, unknown>;

  // Merge file config
  deepMerge(result, fileConfig as Record<string, unknown>);

  // Merge env
  deepMerge(result, env as Record<string, unknown>);

  // Merge cli (highest priority)
  deepMerge(result, cli as Record<string, unknown>);

  // Ensure all required fields are present
  const merged: SettingsData = {
    providers: (result.providers as SettingsData['providers']) || JSON.parse(JSON.stringify(defaults.providers)),
    enable_agent_workflow: (result.enable_agent_workflow as boolean) ?? defaults.enable_agent_workflow,
    providerOrder: (result.providerOrder as string[]) ?? JSON.parse(JSON.stringify(defaults.providerOrder)),
    agent: (result.agent as SettingsData['agent']) || JSON.parse(JSON.stringify(defaults.agent)),
    shell: (result.shell as SettingsData['shell']) || JSON.parse(JSON.stringify(defaults.shell)),
    sandbox: (result.sandbox as SettingsData['sandbox']) || JSON.parse(JSON.stringify(defaults.sandbox)),
    agentWorkflow:
      (result.agentWorkflow as SettingsData['agentWorkflow']) || JSON.parse(JSON.stringify(defaults.agentWorkflow)),
    subagent: (result.subagent as SettingsData['subagent']) || JSON.parse(JSON.stringify(defaults.subagent)),
    ui: (result.ui as SettingsData['ui']) || JSON.parse(JSON.stringify(defaults.ui)),
    logging: (result.logging as SettingsData['logging']) || JSON.parse(JSON.stringify(defaults.logging)),
    environment:
      (result.environment as SettingsData['environment']) || JSON.parse(JSON.stringify(defaults.environment)),
    app: (result.app as SettingsData['app']) || JSON.parse(JSON.stringify(defaults.app)),
    tools: (result.tools as SettingsData['tools']) || JSON.parse(JSON.stringify(defaults.tools)),
    debug: (result.debug as SettingsData['debug']) || JSON.parse(JSON.stringify(defaults.debug)),
    ssh: (result.ssh as SettingsData['ssh']) || JSON.parse(JSON.stringify(defaults.ssh)),
    webSearch: (result.webSearch as SettingsData['webSearch']) || JSON.parse(JSON.stringify(defaults.webSearch)),
    memory: (result.memory as SettingsData['memory']) || JSON.parse(JSON.stringify(defaults.memory)),
  };

  // Validate final result
  const validated = SettingsSchema.safeParse(merged);

  if (validated.success) {
    // Ensure we return a complete SettingsData object
    return {
      providers: merged.providers,
      enable_agent_workflow: merged.enable_agent_workflow,
      providerOrder: merged.providerOrder,
      agent: merged.agent,
      shell: merged.shell,
      sandbox: merged.sandbox,
      agentWorkflow: merged.agentWorkflow,
      subagent: merged.subagent,
      ui: merged.ui,
      logging: merged.logging,
      environment: merged.environment,
      app: merged.app,
      tools: merged.tools,
      debug: merged.debug,
      ssh: merged.ssh,
      webSearch: merged.webSearch,
      memory: merged.memory,
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
  fileConfig: DeepPartial<SettingsData>,
  env: DeepPartial<SettingsData>,
  cli: DeepPartial<SettingsData>,
): Map<string, SettingSource> {
  const sources = new Map<string, SettingSource>();

  const flatDefaults = flattenSettings(defaults);
  const flatFileConfig = flattenSettings(fileConfig);
  const flatEnv = flattenSettings(env);
  const flatCli = flattenSettings(cli);

  // For each possible setting key, determine its source
  for (const key in flatDefaults) {
    if (Object.prototype.hasOwnProperty.call(flatCli, key)) {
      sources.set(key, 'cli');
    } else if (Object.prototype.hasOwnProperty.call(flatEnv, key)) {
      sources.set(key, 'env');
    } else if (Object.prototype.hasOwnProperty.call(flatFileConfig, key)) {
      sources.set(key, 'config');
    } else {
      sources.set(key, 'default');
    }
  }

  return sources;
}
