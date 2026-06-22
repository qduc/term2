import type { SettingSource, SettingsData, SettingsWithSources } from './settings-schema.js';

type SourceGetter = (key: string) => SettingSource;

const SETTINGS_SOURCE_KEYS = {
  agent: {
    model: 'agent.model',
    reasoningEffort: 'agent.reasoningEffort',
    temperature: 'agent.temperature',
    maxTurns: 'agent.maxTurns',
    retryAttempts: 'agent.retryAttempts',
    transport: 'agent.transport',
    maxParallelToolCalls: 'agent.maxParallelToolCalls',
    provider: 'agent.provider',
    openrouter: 'agent.openrouter',
    mentorModel: 'agent.mentorModel',
    mentorProvider: 'agent.mentorProvider',
    mentorReasoningEffort: 'agent.mentorReasoningEffort',
    useFlexServiceTier: 'agent.useFlexServiceTier',
    autoApproveModel: 'agent.autoApproveModel',
    autoApproveProvider: 'agent.autoApproveProvider',
  },
  shell: {
    timeout: 'shell.timeout',
    maxOutputLines: 'shell.maxOutputLines',
    maxOutputChars: 'shell.maxOutputChars',
    autoApproveMode: 'shell.autoApproveMode',
    useRtkCompression: 'shell.useRtkCompression',
  },
  sandbox: {
    enabled: 'sandbox.enabled',
    readPolicy: 'sandbox.readPolicy',
    allowReadExtra: 'sandbox.allowReadExtra',
  },
  ui: {
    historySize: 'ui.historySize',
  },
  logging: {
    logLevel: 'logging.logLevel',
    disableLogging: 'logging.disableLogging',
    debugLogging: 'logging.debugLogging',
    suppressConsoleOutput: 'logging.suppressConsoleOutput',
  },
  environment: {
    nodeEnv: 'environment.nodeEnv',
  },
  app: {
    shellPath: 'app.shellPath',
    mentorMode: 'app.mentorMode',
    liteMode: 'app.liteMode',
    planMode: 'app.planMode',
    orchestratorMode: 'app.orchestratorMode',
    searchViaShell: 'app.searchViaShell',
  },
  tools: {
    logFileOperations: 'tools.logFileOperations',
    enableEditHealing: 'tools.enableEditHealing',
    editHealingModel: 'tools.editHealingModel',
    editHealingProvider: 'tools.editHealingProvider',
  },
  debug: {
    debugBashTool: 'debug.debugBashTool',
  },
  ssh: {
    enabled: 'ssh.enabled',
    host: 'ssh.host',
    port: 'ssh.port',
    username: 'ssh.username',
    remoteDir: 'ssh.remoteDir',
  },
  webSearch: {
    provider: 'webSearch.provider',
    tavily: 'webSearch.tavily',
  },
} as const;

function getValueByPath(settings: SettingsData, path: string): unknown {
  const keys = path.split('.');
  let value: unknown = settings;

  for (const key of keys) {
    if (value == null || typeof value !== 'object') {
      return undefined;
    }

    value = (value as Record<string, unknown>)[key];
  }

  return value;
}

function mapSettingsSection(sourceKeys: unknown, settings: SettingsData, getSource: SourceGetter): unknown {
  if (typeof sourceKeys === 'string') {
    return {
      value: getValueByPath(settings, sourceKeys),
      source: getSource(sourceKeys),
    };
  }

  if (sourceKeys == null || typeof sourceKeys !== 'object') {
    return sourceKeys;
  }

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sourceKeys)) {
    mapped[key] = mapSettingsSection(value, settings, getSource);
  }

  return mapped;
}

export function buildSettingsWithSources(settings: SettingsData, getSource: SourceGetter): SettingsWithSources {
  return mapSettingsSection(SETTINGS_SOURCE_KEYS, settings, getSource) as SettingsWithSources;
}
