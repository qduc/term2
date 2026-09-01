import type { SettingSource, SettingsData, SettingsWithSources } from './settings-schema.js';

type SourceGetter = (key: string) => SettingSource;

const SETTINGS_SOURCE_KEYS = {
  agent: {
    model: 'agent.model',
    efficientModel: 'agent.efficientModel',
    capableModel: 'agent.capableModel',
    smartModel: 'agent.smartModel',
    smartProvider: 'agent.smartProvider',
    smartReasoningEffort: 'agent.smartReasoningEffort',
    balancedModel: 'agent.balancedModel',
    balancedProvider: 'agent.balancedProvider',
    balancedReasoningEffort: 'agent.balancedReasoningEffort',
    cheapModel: 'agent.cheapModel',
    cheapProvider: 'agent.cheapProvider',
    cheapReasoningEffort: 'agent.cheapReasoningEffort',
    choreModel: 'agent.choreModel',
    choreProvider: 'agent.choreProvider',
    reasoningEffort: 'agent.reasoningEffort',
    temperature: 'agent.temperature',
    maxTurns: 'agent.maxTurns',
    retryAttempts: 'agent.retryAttempts',
    transport: 'agent.transport',
    maxParallelToolCalls: 'agent.maxParallelToolCalls',
    runBudget: {
      maxUsdMicros: 'agent.runBudget.maxUsdMicros',
      maxUnpricedTokens: 'agent.runBudget.maxUnpricedTokens',
      maxActiveTimeMs: 'agent.runBudget.maxActiveTimeMs',
      warningHeadroomUsdMicros: 'agent.runBudget.warningHeadroomUsdMicros',
      warningHeadroomUnpricedTokens: 'agent.runBudget.warningHeadroomUnpricedTokens',
      warningHeadroomActiveTimeMs: 'agent.runBudget.warningHeadroomActiveTimeMs',
      softHeadroomUsdMicros: 'agent.runBudget.softHeadroomUsdMicros',
      softHeadroomUnpricedTokens: 'agent.runBudget.softHeadroomUnpricedTokens',
      softHeadroomActiveTimeMs: 'agent.runBudget.softHeadroomActiveTimeMs',
      turnBackstop: 'agent.runBudget.turnBackstop',
      extensionPercent: 'agent.runBudget.extensionPercent',
      maxParentExtensions: 'agent.runBudget.maxParentExtensions',
      identicalToolCallThreshold: 'agent.runBudget.identicalToolCallThreshold',
      escalation: 'agent.runBudget.escalation',
    },
    backgroundCheckIn: {
      enabled: 'agent.backgroundCheckIn.enabled',
      intervalMs: 'agent.backgroundCheckIn.intervalMs',
    },
    sessionRollover: {
      enabled: 'agent.sessionRollover.enabled',
      milestones: 'agent.sessionRollover.milestones',
      autoBrief: 'agent.sessionRollover.autoBrief',
    },
    provider: 'agent.provider',
    openrouter: 'agent.openrouter',
    codex: {
      websocketFirstFrameTimeoutMs: 'agent.codex.websocketFirstFrameTimeoutMs',
      websocketInterFrameTimeoutMs: 'agent.codex.websocketInterFrameTimeoutMs',
    },
    mentorModel: 'agent.mentorModel',
    mentorProvider: 'agent.mentorProvider',
    mentorReasoningEffort: 'agent.mentorReasoningEffort',
    useFlexServiceTier: 'agent.useFlexServiceTier',
    contextCompaction: {
      enabled: 'agent.contextCompaction.enabled',
      mode: 'agent.contextCompaction.mode',
      compactThreshold: 'agent.contextCompaction.compactThreshold',
      compactThresholdTokens: 'agent.contextCompaction.compactThresholdTokens',
    },
    autoApproveModel: 'agent.autoApproveModel',
    autoApproveProvider: 'agent.autoApproveProvider',
    autoApproveReasoningEffort: 'agent.autoApproveReasoningEffort',
  },
  shell: {
    timeout: 'shell.timeout',
    backgroundTimeout: 'shell.backgroundTimeout',
    maxOutputLines: 'shell.maxOutputLines',
    maxOutputChars: 'shell.maxOutputChars',
    autoApproveMode: 'shell.autoApproveMode',
    useRtkCompression: 'shell.useRtkCompression',
  },
  sandbox: {
    enabled: 'sandbox.enabled',
    readPolicy: 'sandbox.readPolicy',
    allowReadExtra: 'sandbox.allowReadExtra',
    dockerHostControlProjects: 'sandbox.dockerHostControlProjects',
    allowNetworking: 'sandbox.allowNetworking',
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
