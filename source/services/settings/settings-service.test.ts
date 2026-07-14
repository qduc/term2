import { it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsService } from './settings-service.js';
import { getProvider, getAllProviders } from '../../providers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_BASE_DIR = path.join(__dirname, '../../test-settings');

let testCounter = 0;

// Helper to get unique settings directory per test
const getTestSettingsDir = () => {
  testCounter += 1;
  return path.join(TEST_BASE_DIR, `test-${testCounter}`);
};

const getSettingsFilePath = (settingsDir: string) => path.join(settingsDir, 'settings.json');

// AVA (and other runners) set environment variables that we use to detect a test environment.
// Some tests need to validate the *non-test* behavior (i.e., persistence to disk).
// We isolate those by temporarily clearing the test-runner env markers.
async function withNonTestEnvironment(fn: () => Promise<void>) {
  const snapshot = {
    NODE_ENV: process.env.NODE_ENV,
    AVA_PATH: process.env.AVA_PATH,
    JEST_WORKER_ID: process.env.JEST_WORKER_ID,
    VITEST: process.env.VITEST,
    TERM2_TEST_MODE: process.env.TERM2_TEST_MODE,
  };

  try {
    // Ensure we do not look like a test environment to SettingsService.
    // Setting NODE_ENV to a non-test value helps for setups that might default it.
    process.env.NODE_ENV = 'production';
    delete process.env.AVA_PATH;
    delete process.env.JEST_WORKER_ID;
    delete process.env.VITEST;
    delete process.env.TERM2_TEST_MODE;

    return await fn();
  } finally {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// Helper to clean up test settings
const cleanupSettings = () => {
  if (fs.existsSync(TEST_BASE_DIR)) {
    fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
};

beforeAll(() => {
  cleanupSettings();
});

afterAll(() => {
  cleanupSettings();
});

it('SettingsService initializes with defaults', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(service).toBeTruthy();
  expect(service.get('agent.model')).toBe('gpt-5.1');
  expect(service.get('agent.reasoningEffort')).toBe('default');
  expect(service.get('agent.temperature')).toBe(undefined);
  expect(service.get('agent.maxTurns')).toBe(100);
  expect(service.get('agent.retryAttempts')).toBe(2);
  expect(service.get('agent.maxParallelToolCalls')).toBe(3);
  expect(service.get('shell.timeout')).toBe(120000);
  expect(service.get('shell.maxOutputLines')).toBe(1000);
  expect(service.get('shell.maxOutputChars')).toBe(40000);
  expect(service.get('ui.historySize')).toBe(1000);
  expect(service.get('logging.logLevel')).toBe('info');
});

it('skips file writes in test environment (constructor + set)', async () => {
  const settingsDir = getTestSettingsDir();
  const settingsFile = getSettingsFilePath(settingsDir);

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(fs.existsSync(settingsFile)).toBe(false);

  service.set('agent.model', 'gpt-4o');
  expect(fs.existsSync(settingsFile)).toBe(false);
});

it.sequential('disableFilePersistence: true prevents writes even outside test environment', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();
    const settingsFile = getSettingsFilePath(settingsDir);

    const service = new SettingsService({
      settingsDir,
      disableLogging: true,
      disableFilePersistence: true,
    });

    expect(fs.existsSync(settingsFile)).toBe(false);

    service.set('agent.model', 'gpt-4o');
    expect(fs.existsSync(settingsFile)).toBe(false);
  });
});

it.sequential('normal operation persists settings.json when not in test environment', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();
    const settingsFile = getSettingsFilePath(settingsDir);

    const service = new SettingsService({
      settingsDir,
      disableLogging: true,
    });

    expect(fs.existsSync(settingsFile)).toBe(true);

    service.set('agent.model', 'gpt-4o');

    const content = fs.readFileSync(settingsFile, 'utf-8');
    const config = JSON.parse(content);
    expect(config.agent.model).toBe('gpt-4o');
  });
});

it('creates settings directory if it does not exist', async () => {
  const settingsDir = getTestSettingsDir();
  new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(fs.existsSync(settingsDir)).toBe(true);
});

it('CLI overrides take highest precedence', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    cli: {
      agent: {
        model: 'gpt-4o',
      },
    } as any,
  });

  expect(service.get('agent.model')).toBe('gpt-4o');
  expect(service.getSource('agent.model')).toBe('cli');
});

it('env overrides config file but not CLI', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      agent: {
        model: 'gpt-3.5-turbo',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    env: {
      agent: {
        model: 'gpt-4-turbo',
      },
    } as any,
  });

  expect(service.get('agent.model')).toBe('gpt-4-turbo');
  expect(service.getSource('agent.model')).toBe('env');

  // Now test with CLI override
  const service2 = new SettingsService({
    settingsDir,
    disableLogging: true,
    env: {
      agent: {
        model: 'gpt-4-turbo',
      },
    } as any,
    cli: {
      agent: {
        model: 'gpt-5.1',
      },
    } as any,
  });

  expect(service2.get('agent.model')).toBe('gpt-5.1');
  expect(service2.getSource('agent.model')).toBe('cli');
});

it('config file overrides defaults', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      shell: {
        timeout: 60000,
        maxOutputChars: 5000,
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(service.get('shell.timeout')).toBe(60000);
  expect(service.get('shell.maxOutputChars')).toBe(5000);
  expect(service.getSource('shell.timeout')).toBe('config');
});

it('registers custom OpenAI-compatible providers from settings.json', async () => {
  const settingsDir = getTestSettingsDir();

  const providerName = 'lmstudio-settings-service-test';

  // TODO: // TODO: t.teardown(() => unregisterProvider(providerName)) needs manual try/finally conversion;

  // Create a config file with providers
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      providers: [
        {
          id: providerName,
          name: 'LM Studio Test',
          baseUrl: 'http://localhost:1234',
          apiKey: 'my-secret-api-key',
        },
      ],
      agent: {
        provider: providerName,
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Provider should be registered and selectable
  expect(getProvider(providerName)).toBeTruthy();
  expect(getAllProviders().some((p) => p.id === providerName)).toBe(true);
  expect(service.get('agent.provider')).toBe(providerName);
});

it('custom providers default missing type for old settings.json files', async () => {
  const settingsDir = getTestSettingsDir();

  const providerName = 'legacy-compatible-settings-service-test';

  // TODO: // TODO: t.teardown(() => unregisterProvider(providerName)) needs manual try/finally conversion;

  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      providers: [
        {
          name: providerName,
          baseUrl: 'http://localhost:1234',
        },
      ],
      agent: {
        provider: providerName,
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    disableFilePersistence: true,
  });

  expect(service.get('providers')[0].type).toBe('openai-compatible');
  expect(service.get('providers')[0].id).toBe(providerName);
  expect(service.get('providers')[0].name).toBe(providerName);
});

it('migrates name-only custom provider to id with underscores', async () => {
  const settingsDir = getTestSettingsDir();

  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      providers: [
        {
          displayName: 'My Local Provider',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:1234',
        },
      ],
      agent: {
        provider: 'My_Local_Provider',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    disableFilePersistence: true,
  });

  const providers = service.get<any[]>('providers');
  expect(providers[0].id).toBe('My_Local_Provider');
  expect(providers[0].name).toBe('My Local Provider');
  expect(service.get('agent.provider')).toBe('My_Local_Provider');
  expect(getProvider('My_Local_Provider')).toBeTruthy();
});

it('migrates legacy agent.provider names with spaces to normalized provider id', async () => {
  const settingsDir = getTestSettingsDir();

  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      providers: [
        {
          name: 'My Local Provider',
          type: 'openai-compatible',
          baseUrl: 'http://localhost:1234',
        },
      ],
      agent: {
        provider: 'My Local Provider',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    disableFilePersistence: true,
  });

  expect(service.get('agent.provider')).toBe('My_Local_Provider');
  expect(getProvider('My_Local_Provider')).toBeTruthy();
});

it.sequential('startup rewrites legacy provider format to new format in settings.json', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();
    const configFile = path.join(settingsDir, 'settings.json');

    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    fs.writeFileSync(
      configFile,
      JSON.stringify(
        {
          providers: [
            {
              name: 'Legacy Local Provider',
              type: 'openai-compatible',
              baseUrl: 'http://localhost:1234',
            },
          ],
          agent: {
            provider: 'Legacy_Local_Provider',
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const service = new SettingsService({
      settingsDir,
      disableLogging: true,
    });

    expect(service.get('agent.provider')).toBe('Legacy_Local_Provider');

    const rewritten = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
    expect(rewritten.providers[0].id).toBe('Legacy_Local_Provider');
    expect(rewritten.providers[0].name).toBe('Legacy Local Provider');
  });
});

it('migrates legacy ancillary settings into tier settings without overwriting new values', () => {
  const settingsDir = getTestSettingsDir();
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    getSettingsFilePath(settingsDir),
    JSON.stringify({
      agent: {
        capableModel: 'legacy-capable',
        mentorProvider: 'legacy-smart-provider',
        mentorReasoningEffort: 'high',
        subagentWorkerModel: 'legacy-worker',
        subagentWorkerProvider: 'legacy-balanced-provider',
        subagentWorkerReasoningEffort: 'medium',
        efficientModel: 'legacy-efficient',
        subagentExplorerProvider: 'legacy-cheap-provider',
        subagentExplorerReasoningEffort: 'low',
        autoApproveModel: 'legacy-chore',
        autoApproveProvider: 'legacy-chore-provider',
        smartModel: 'new-smart',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({ settingsDir, disableLogging: true, disableFilePersistence: true });

  expect({
    smart: [
      service.get('agent.smartModel'),
      service.get('agent.smartProvider'),
      service.get('agent.smartReasoningEffort'),
    ],
    balanced: [
      service.get('agent.balancedModel'),
      service.get('agent.balancedProvider'),
      service.get('agent.balancedReasoningEffort'),
    ],
    cheap: [
      service.get('agent.cheapModel'),
      service.get('agent.cheapProvider'),
      service.get('agent.cheapReasoningEffort'),
    ],
    chore: [service.get('agent.choreModel'), service.get('agent.choreProvider')],
  }).toEqual({
    smart: ['new-smart', 'legacy-smart-provider', 'high'],
    balanced: ['legacy-worker', 'legacy-balanced-provider', 'medium'],
    cheap: ['legacy-efficient', 'legacy-cheap-provider', 'low'],
    chore: ['legacy-chore', 'legacy-chore-provider'],
  });
});

it.sequential('startup persists migrated ancillary tier settings', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();
    fs.mkdirSync(settingsDir, { recursive: true });
    const settingsFile = getSettingsFilePath(settingsDir);
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ agent: { subagentWorkerModel: 'legacy-worker', subagentWorkerReasoningEffort: 'high' } }),
      'utf-8',
    );

    new SettingsService({ settingsDir, disableLogging: true });

    const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(persisted.agent.balancedModel).toBe('legacy-worker');
    expect(persisted.agent.balancedReasoningEffort).toBe('high');
  });
});

it('set() modifies runtime-modifiable settings', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  service.set('agent.model', 'gpt-4o');
  expect(service.get('agent.model')).toBe('gpt-4o');
  expect(service.getSource('agent.model')).toBe('cli');

  service.set('agent.temperature', 0.2);
  expect(service.get('agent.temperature')).toBe(0.2);
  expect(service.getSource('agent.temperature')).toBe('cli');

  service.set('agent.maxParallelToolCalls', 5);
  expect(service.get('agent.maxParallelToolCalls')).toBe(5);
  expect(service.getSource('agent.maxParallelToolCalls')).toBe('cli');
});

it('set() throws for startup-only settings', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(() => {
    service.set('agent.maxTurns', 30);
  }).toThrow(/Cannot modify.*at runtime/);
});

it('setPersistent() saves startup-only settings after validating them', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    disableFilePersistence: true,
  });

  service.setPersistent('agent.maxTurns', 30);

  expect(service.get('agent.maxTurns')).toBe(30);
  expect(service.getSource('agent.maxTurns')).toBe('cli');
});

it('setPersistent() rejects invalid values', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    disableFilePersistence: true,
  });

  expect(() => {
    service.setPersistent('agent.maxTurns', 0);
  }).toThrow(/Invalid value for 'agent.maxTurns'/);
});

it('isRuntimeModifiable identifies correct settings', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Runtime-modifiable settings
  expect(service.isRuntimeModifiable('agent.model')).toBe(true);
  expect(service.isRuntimeModifiable('agent.reasoningEffort')).toBe(true);
  expect(service.isRuntimeModifiable('agent.temperature')).toBe(true);
  expect(service.isRuntimeModifiable('agent.retryAttempts')).toBe(true);
  expect(service.isRuntimeModifiable('agent.maxParallelToolCalls')).toBe(true);
  expect(service.isRuntimeModifiable('tools.editHealingModel')).toBe(true);
  expect(service.isRuntimeModifiable('tools.editHealingProvider')).toBe(true);
  expect(service.isRuntimeModifiable('shell.timeout')).toBe(true);
  expect(service.isRuntimeModifiable('shell.maxOutputLines')).toBe(true);
  expect(service.isRuntimeModifiable('shell.maxOutputChars')).toBe(true);
  expect(service.isRuntimeModifiable('logging.logLevel')).toBe(true);

  // Startup-only settings
  expect(service.isRuntimeModifiable('agent.maxTurns')).toBe(false);
  expect(service.isRuntimeModifiable('ui.historySize')).toBe(false);
});

it('reset() clones object defaults instead of reusing shared references', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  service.reset('agent.openrouter');
  const firstResetValue = service.get('agent.openrouter');
  firstResetValue.apiKey = 'mutated-secret';

  service.reset('agent.openrouter');
  const secondResetValue = service.get('agent.openrouter');

  expect(secondResetValue).toEqual({});
  expect(secondResetValue).not.toBe(firstResetValue);
});

it('reset() returns setting to default', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      shell: {
        timeout: 60000,
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(service.get('shell.timeout')).toBe(60000);

  service.reset('shell.timeout');
  expect(service.get('shell.timeout')).toBe(120000);
});

it('getAll() returns all settings with sources', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    cli: {
      agent: {
        model: 'gpt-4o',
      },
    } as any,
  });

  const all = service.getAll();

  expect(all.agent).toBeTruthy();
  expect(all.shell).toBeTruthy();
  expect(all.ui).toBeTruthy();
  expect(all.logging).toBeTruthy();
  expect(all.agent.model.value).toBe('gpt-4o');
  expect(all.agent.model.source).toBe('cli');
  expect(all.agent.reasoningEffort.value).toBe('default');
  expect(all.agent.reasoningEffort.source).toBe('default');
  expect(all.agent.maxParallelToolCalls.value).toBe(3);
  expect(all.agent.maxParallelToolCalls.source).toBe('default');
});

it('getAll() maps optional nested values and sources for agent.temperature and webSearch.tavily', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    env: {
      webSearch: {
        tavily: undefined,
      },
    },
  });

  const all = service.getAll();

  expect(all.agent.temperature.value).toBe(undefined);
  expect(all.agent.temperature.source).toBe('default');
  expect(all.webSearch.tavily.value).toBe(undefined);
  expect(all.webSearch.tavily.source).toBe('default');
});

it('SettingsService initialization applies logging.logLevel to loggingService', async () => {
  const settingsDir = getTestSettingsDir();
  const mockLoggingService = {
    setLogLevel: (level: string) => {
      mockLoggingService._level = level;
    },
    getLogLevel: () => mockLoggingService._level || 'info',
    _level: 'info',
  };

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    loggingService: mockLoggingService as any,
    cli: {
      logging: { logLevel: 'debug' },
    } as any,
  });

  expect(service.get('logging.logLevel')).toBe('debug');
  expect(mockLoggingService.getLogLevel()).toBe('debug');
});

it('SettingsService runtime set updates loggingService', async () => {
  const settingsDir = getTestSettingsDir();
  const mockLoggingService = {
    setLogLevel: (level: string) => {
      mockLoggingService._level = level;
    },
    getLogLevel: () => mockLoggingService._level || 'info',
    _level: 'info',
  };

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    loggingService: mockLoggingService as any,
  });

  // Initially default
  expect(service.get('logging.logLevel')).toBe('info');

  service.set('logging.logLevel', 'debug');

  expect(service.get('logging.logLevel')).toBe('debug');
  expect(mockLoggingService.getLogLevel()).toBe('debug');
});

it('gracefully degrades on invalid config file', async () => {
  const settingsDir = getTestSettingsDir();

  // Create an invalid config file
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(configFile, 'invalid json {', 'utf-8');

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Should load defaults and not throw
  expect(service.get('agent.model')).toBe('gpt-5.1');
});

it('gracefully degrades on invalid schema in config file', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file with invalid values
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      shell: {
        timeout: -100, // invalid: negative
        maxOutputChars: 'not a number', // invalid
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Should fall back to defaults for invalid settings
  expect(service.get('shell.timeout')).toBe(120000);
  expect(service.get('shell.maxOutputChars')).toBe(40000);
});

it('loads settings from config file on startup', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      agent: {
        model: 'custom-model',
        reasoningEffort: 'high',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(service.get('agent.model')).toBe('custom-model');
  expect(service.get('agent.reasoningEffort')).toBe('high');
});

it('accepts xhigh reasoning effort for newer reasoning models', async () => {
  const settingsDir = getTestSettingsDir();

  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      agent: {
        reasoningEffort: 'xhigh',
        mentorReasoningEffort: 'xhigh',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(service.get('agent.reasoningEffort')).toBe('xhigh');
  expect(service.get('agent.mentorReasoningEffort')).toBe('xhigh');
});

it.sequential('persists changes to config file', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
      settingsDir,
      disableLogging: true,
    });

    service.set('agent.model', 'gpt-4o');

    // Read the config file directly
    const configFile = path.join(settingsDir, 'settings.json');
    const content = fs.readFileSync(configFile, 'utf-8');
    const config = JSON.parse(content);

    expect(config.agent.model).toBe('gpt-4o');
  });
});

it('tracks setting sources correctly', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      shell: {
        timeout: 60000,
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    env: {
      agent: {
        reasoningEffort: 'medium',
      },
    } as any,
    cli: {
      agent: {
        model: 'gpt-4o',
      },
    } as any,
  });

  expect(service.getSource('agent.model')).toBe('cli');
  expect(service.getSource('agent.reasoningEffort')).toBe('env');
  expect(service.getSource('shell.timeout')).toBe('config');
  expect(service.getSource('agent.maxTurns')).toBe('default');
});

it('deep merges partial settings from multiple sources', async () => {
  const settingsDir = getTestSettingsDir();

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
    cli: {
      agent: {
        model: 'cli-model',
        // reasoningEffort not set in CLI
      },
    } as any,
    env: {
      shell: {
        timeout: 60000,
        // maxOutputLines not set in env
      },
    } as any,
  });

  // CLI should override for agent.model
  expect(service.get('agent.model')).toBe('cli-model');

  // Default for agent.reasoningEffort since not in CLI
  expect(service.get('agent.reasoningEffort')).toBe('default');

  // Env should override for shell.timeout
  expect(service.get('shell.timeout')).toBe(60000);

  // Default for shell.maxOutputLines since not in env
  expect(service.get('shell.maxOutputLines')).toBe(1000);
});

it('getSource() returns default when setting not overridden', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(service.getSource('agent.model')).toBe('default');
  expect(service.getSource('shell.timeout')).toBe('default');
  expect(service.getSource('ui.historySize')).toBe('default');
});

it('validates enum values', async () => {
  const settingsDir = getTestSettingsDir();

  // Create a config file with invalid enum value
  const configFile = path.join(settingsDir, 'settings.json');
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  fs.writeFileSync(
    configFile,
    JSON.stringify({
      agent: {
        reasoningEffort: 'invalid-effort',
      },
    }),
    'utf-8',
  );

  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Should fall back to default for invalid enum
  expect(service.get('agent.reasoningEffort')).toBe('default');
});

it('respects disableLogging flag', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  service.set('agent.model', 'gpt-4o');

  // Should not throw
  expect(true).toBe(true);
});

it.sequential('updates config file when new settings are added', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();
    const configFile = path.join(settingsDir, 'settings.json');

    // Create a minimal config file without the 'provider' field
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    fs.writeFileSync(
      configFile,
      JSON.stringify({
        agent: {
          model: 'gpt-4o',
          reasoningEffort: 'default',
          maxTurns: 20,
          retryAttempts: 2,
          // Note: provider field is missing
        },
      }),
      'utf-8',
    );

    // Initialize service - it should detect missing 'provider' and update the file
    const service = new SettingsService({
      settingsDir,
      disableLogging: true,
    });

    // Verify service has the provider setting with default value
    expect(service.get('agent.provider')).toBe('openai');

    // Verify the file was updated with the new setting
    const updatedContent = fs.readFileSync(configFile, 'utf-8');
    const updatedConfig = JSON.parse(updatedContent);

    expect(updatedConfig.agent.provider).toBe('openai');
  });
});

it.sequential('does not update config file when no new settings are added', async () => {
  const settingsDir = getTestSettingsDir();
  const configFile = path.join(settingsDir, 'settings.json');

  // Create a complete config file with all current settings
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  const originalConfig = {
    agent: {
      model: 'gpt-4o',
      reasoningEffort: 'default',
      maxTurns: 20,
      retryAttempts: 2,

      provider: 'openai',
      openrouter: {},
    },
    shell: {
      timeout: 120000,
      maxOutputLines: 1000,
      maxOutputChars: 40000,
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
      mode: 'default',
    },
    tools: {
      logFileOperations: true,
    },
    debug: {
      debugBashTool: false,
    },
  };

  fs.writeFileSync(configFile, JSON.stringify(originalConfig), 'utf-8');
  // Spy on loggingService to ensure no update was triggered
  let updateLogged = false;
  const mockLogging = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: (msg: string, meta: any) => {
      if (msg.includes('Updated settings file') && meta?.settingsFile?.startsWith(settingsDir)) {
        updateLogged = true;
      }
    },
    security: () => {},
    setLogLevel: () => {},
    getLogLevel: () => 'info',
    setCorrelationId: () => {},
  };

  // Initialize service - it should NOT update the file since all settings are present
  new SettingsService({
    settingsDir,
    disableLogging: false,
    loggingService: mockLogging as any,
  });

  expect(updateLogged).toBe(false);
});

it.sequential('does not update config file when format differs but content is same', async () => {
  const settingsDir = getTestSettingsDir();
  const configFile = path.join(settingsDir, 'settings.json');

  // Create directory
  if (!fs.existsSync(settingsDir)) {
    fs.mkdirSync(settingsDir, { recursive: true });
  }

  // Write config with compact JSON (no formatting, different key order)
  const compactConfig = {
    agent: {
      model: 'gpt-4o',
      reasoningEffort: 'default',
      maxTurns: 20,
      retryAttempts: 2,
      provider: 'openai',
      openrouter: {},
    },
    shell: {
      timeout: 120000,
      maxOutputLines: 1000,
      maxOutputChars: 40000,
    },
    ui: { historySize: 1000 },
    logging: {
      logLevel: 'info',
      disableLogging: false,
      debugLogging: false,
      suppressConsoleOutput: true,
    },
    environment: { nodeEnv: undefined },
    app: { shellPath: undefined, mode: 'default' },
    tools: { logFileOperations: true },
    debug: { debugBashTool: false },
  };

  fs.writeFileSync(configFile, JSON.stringify(compactConfig), 'utf-8');
  // Spy on loggingService to ensure no update was triggered
  let updateLogged = false;
  const mockLogging = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: (msg: string, meta: any) => {
      if (msg.includes('Updated settings file') && meta?.settingsFile?.startsWith(settingsDir)) {
        updateLogged = true;
      }
    },
    security: () => {},
    setLogLevel: () => {},
    getLogLevel: () => 'info',
    setCorrelationId: () => {},
  };

  // Initialize service - it should NOT update the file even though format differs
  new SettingsService({
    settingsDir,
    disableLogging: false,
    loggingService: mockLogging as any,
  });

  expect(updateLogged).toBe(false);
});
it('isSensitive() identifies sensitive settings', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Sensitive settings
  expect(service.isSensitive('agent.openrouter.baseUrl')).toBe(true);
  expect(service.isSensitive('agent.openrouter.referrer')).toBe(true);
  expect(service.isSensitive('agent.openrouter.title')).toBe(true);
  expect(service.isSensitive('app.shellPath')).toBe(true);

  // Non-sensitive settings
  expect(service.isSensitive('agent.model')).toBe(false);
  expect(service.isSensitive('agent.openrouter.model')).toBe(false);
  expect(service.isSensitive('shell.timeout')).toBe(false);
  expect(service.isSensitive('logging.logLevel')).toBe(false);
  expect(service.isSensitive('agent.openrouter.apiKey')).toBe(false);
  expect(service.isSensitive('agent.openai.apiKey')).toBe(false);
  expect(service.isSensitive('webSearch.tavily.apiKey')).toBe(false);
  expect(service.isSensitive('webSearch.exa.apiKey')).toBe(false);
});

it('set() throws for sensitive settings', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(() => {
    service.set('agent.openrouter.baseUrl', 'https://internal.api.com');
  }).toThrow(/sensitive setting/);
});

it('reset() throws for sensitive settings', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  expect(() => {
    service.reset('agent.openrouter.baseUrl');
  }).toThrow(/sensitive setting/);
});

it.sequential('sensitive settings are never saved to config file', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();

    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }

    // Initialize with sensitive env values
    new SettingsService({
      settingsDir,
      disableLogging: true,
      env: {
        agent: {
          openrouter: {
            apiKey: 'sk-secret-key',
            baseUrl: 'https://internal.api.com',
            referrer: 'internal-app',
            title: 'My Secret App',
            model: 'gpt-4', // NOT sensitive
          },
        },
        app: {
          shellPath: '/bin/bash',
        },
      } as any,
    });

    // Read the saved config file
    const configFile = path.join(settingsDir, 'settings.json');
    const content = fs.readFileSync(configFile, 'utf-8');
    const config = JSON.parse(content);

    // Verify sensitive values are NOT in the file
    expect(config.agent?.openrouter?.baseUrl).toBeFalsy();
    expect(config.agent?.openrouter?.referrer).toBeFalsy();
    expect(config.agent?.openrouter?.title).toBeFalsy();
    expect(config.app?.shellPath).toBeFalsy();

    // Verify non-sensitive openrouter values ARE saved
    expect(config.agent?.openrouter?.model, 'model should be saved').toBe('gpt-4');
    expect(config.agent?.openrouter?.apiKey, 'apiKey should be saved').toBe('sk-secret-key');
  });
});

it.sequential('sensitive settings loaded from env are accessible at runtime', async () => {
  await withNonTestEnvironment(async () => {
    const settingsDir = getTestSettingsDir();

    const service = new SettingsService({
      settingsDir,
      disableLogging: true,
      env: {
        agent: {
          openrouter: {
            apiKey: 'sk-secret-key',
            baseUrl: 'https://internal.api.com',
          },
        },
        app: {
          shellPath: '/bin/bash',
        },
      } as any,
    });

    // Verify sensitive values ARE accessible at runtime
    expect(service.get('agent.openrouter.apiKey')).toBe('sk-secret-key');
    expect(service.get('agent.openrouter.baseUrl')).toBe('https://internal.api.com');
    expect(service.get('app.shellPath')).toBe('/bin/bash');

    // But they should not be in the saved file
    const configFile = path.join(settingsDir, 'settings.json');
    const content = fs.readFileSync(configFile, 'utf-8');
    const config = JSON.parse(content);

    expect(config.agent?.openrouter?.baseUrl).toBeFalsy();
    expect(config.app?.shellPath).toBeFalsy();
    expect(config.agent?.openrouter?.apiKey).toBe('sk-secret-key');
  });
});

it('set() enables target app mode and disables sibling modes', async () => {
  const settingsDir = getTestSettingsDir();
  const service = new SettingsService({
    settingsDir,
    disableLogging: true,
  });

  // Enable orchestrator mode initially
  service.set('app.orchestratorMode', true);
  expect(service.get('app.orchestratorMode')).toBe(true);
  expect(service.get('app.liteMode')).toBe(false);
  expect(service.get('app.planMode')).toBe(false);
  expect(service.get('app.mentorMode')).toBe(false);

  // Setting liteMode to true should disable orchestratorMode
  service.set('app.liteMode', true);
  expect(service.get('app.liteMode')).toBe(true);
  expect(service.get('app.orchestratorMode')).toBe(false);
  expect(service.get('app.planMode')).toBe(false);
  expect(service.get('app.mentorMode')).toBe(false);

  // Setting planMode to true should disable liteMode
  service.set('app.planMode', true);
  expect(service.get('app.planMode')).toBe(true);
  expect(service.get('app.liteMode')).toBe(false);
  expect(service.get('app.orchestratorMode')).toBe(false);
  expect(service.get('app.mentorMode')).toBe(false);
});
