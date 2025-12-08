import test from 'ava';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SettingsService} from '../../dist/services/settings-service.js';
import {loggingService} from '../../dist/services/logging-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_BASE_DIR = path.join(__dirname, '../../test-settings');

let testCounter = 0;

// Helper to get unique settings directory per test
const getTestSettingsDir = () => {
    testCounter += 1;
    return path.join(TEST_BASE_DIR, `test-${testCounter}`);
};

// Helper to clean up test settings
const cleanupSettings = () => {
    if (fs.existsSync(TEST_BASE_DIR)) {
        fs.rmSync(TEST_BASE_DIR, {recursive: true, force: true});
    }
};

test.before(() => {
    cleanupSettings();
});

test.after.always(() => {
    cleanupSettings();
});

test('SettingsService initializes with defaults', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    t.truthy(service);
    t.is(service.get('agent.model'), 'gpt-5.1');
    t.is(service.get('agent.reasoningEffort'), 'default');
    t.is(service.get('agent.maxTurns'), 20);
    t.is(service.get('agent.retryAttempts'), 2);
    t.is(service.get('shell.timeout'), 120000);
    t.is(service.get('shell.maxOutputLines'), 1000);
    t.is(service.get('shell.maxOutputChars'), 10000);
    t.is(service.get('ui.historySize'), 1000);
    t.is(service.get('logging.logLevel'), 'info');
});

test('creates settings directory if it does not exist', async t => {
    const settingsDir = getTestSettingsDir();
    new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    // Give it a moment to create the directory
    await new Promise(resolve => setTimeout(resolve, 100));

    t.true(fs.existsSync(settingsDir));
});

test('CLI overrides take highest precedence', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
        cli: {
            agent: {
                model: 'gpt-4o',
            },
        },
    });

    t.is(service.get('agent.model'), 'gpt-4o');
    t.is(service.getSource('agent.model'), 'cli');
});

test('env overrides config file but not CLI', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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
        },
    });

    t.is(service.get('agent.model'), 'gpt-4-turbo');
    t.is(service.getSource('agent.model'), 'env');

    // Now test with CLI override
    const service2 = new SettingsService({
        settingsDir,
        disableLogging: true,
        env: {
            agent: {
                model: 'gpt-4-turbo',
            },
        },
        cli: {
            agent: {
                model: 'gpt-5.1',
            },
        },
    });

    t.is(service2.get('agent.model'), 'gpt-5.1');
    t.is(service2.getSource('agent.model'), 'cli');
});

test('config file overrides defaults', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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

    t.is(service.get('shell.timeout'), 60000);
    t.is(service.get('shell.maxOutputChars'), 5000);
    t.is(service.getSource('shell.timeout'), 'config');
});

test('set() modifies runtime-modifiable settings', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    service.set('agent.model', 'gpt-4o');
    t.is(service.get('agent.model'), 'gpt-4o');
    t.is(service.getSource('agent.model'), 'cli');
});

test('set() throws for startup-only settings', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    const error = t.throws(() => {
        service.set('agent.maxTurns', 30);
    });

    t.true(
        error.message.includes('Cannot modify') &&
            error.message.includes('at runtime'),
    );
});

test('isRuntimeModifiable identifies correct settings', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    // Runtime-modifiable settings
    t.true(service.isRuntimeModifiable('agent.model'));
    t.true(service.isRuntimeModifiable('agent.reasoningEffort'));
    t.true(service.isRuntimeModifiable('shell.timeout'));
    t.true(service.isRuntimeModifiable('shell.maxOutputLines'));
    t.true(service.isRuntimeModifiable('shell.maxOutputChars'));
    t.true(service.isRuntimeModifiable('logging.logLevel'));

    // Startup-only settings
    t.false(service.isRuntimeModifiable('agent.maxTurns'));
    t.false(service.isRuntimeModifiable('agent.retryAttempts'));
    t.false(service.isRuntimeModifiable('ui.historySize'));
});

test('reset() returns setting to default', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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

    t.is(service.get('shell.timeout'), 60000);

    service.reset('shell.timeout');
    t.is(service.get('shell.timeout'), 120000);
});

test('getAll() returns all settings with sources', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
        cli: {
            agent: {
                model: 'gpt-4o',
            },
        },
    });

    const all = service.getAll();

    t.truthy(all.agent);
    t.truthy(all.shell);
    t.truthy(all.ui);
    t.truthy(all.logging);
    t.is(all.agent.model.value, 'gpt-4o');
    t.is(all.agent.model.source, 'cli');
    t.is(all.agent.reasoningEffort.value, 'default');
    t.is(all.agent.reasoningEffort.source, 'default');
});

test('SettingsService initialization applies logging.logLevel to loggingService', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
        cli: {
            logging: {logLevel: 'debug'},
        },
    });

    t.is(service.get('logging.logLevel'), 'debug');
    t.is(loggingService.getLogLevel(), 'debug');
});

test('SettingsService runtime set updates loggingService', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    // Initially default
    t.is(service.get('logging.logLevel'), 'info');

    service.set('logging.logLevel', 'debug');

    t.is(service.get('logging.logLevel'), 'debug');
    t.is(loggingService.getLogLevel(), 'debug');
});

test('gracefully degrades on invalid config file', async t => {
    const settingsDir = getTestSettingsDir();

    // Create an invalid config file
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
    }

    fs.writeFileSync(configFile, 'invalid json {', 'utf-8');

    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    // Should load defaults and not throw
    t.is(service.get('agent.model'), 'gpt-5.1');
});

test('gracefully degrades on invalid schema in config file', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file with invalid values
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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
    t.is(service.get('shell.timeout'), 120000);
    t.is(service.get('shell.maxOutputChars'), 10000);
});

test('loads settings from config file on startup', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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

    t.is(service.get('agent.model'), 'custom-model');
    t.is(service.get('agent.reasoningEffort'), 'high');
});

test('persists changes to config file', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    service.set('agent.model', 'gpt-4o');

    // Give it a moment to write
    await new Promise(resolve => setTimeout(resolve, 100));

    // Read the config file directly
    const configFile = path.join(settingsDir, 'settings.json');
    const content = fs.readFileSync(configFile, 'utf-8');
    const config = JSON.parse(content);

    t.is(config.agent.model, 'gpt-4o');
});

test('tracks setting sources correctly', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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
        },
        cli: {
            agent: {
                model: 'gpt-4o',
            },
        },
    });

    t.is(service.getSource('agent.model'), 'cli');
    t.is(service.getSource('agent.reasoningEffort'), 'env');
    t.is(service.getSource('shell.timeout'), 'config');
    t.is(service.getSource('agent.maxTurns'), 'default');
});

test('deep merges partial settings from multiple sources', async t => {
    const settingsDir = getTestSettingsDir();

    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
        cli: {
            agent: {
                model: 'cli-model',
                // reasoningEffort not set in CLI
            },
        },
        env: {
            shell: {
                timeout: 60000,
                // maxOutputLines not set in env
            },
        },
    });

    // CLI should override for agent.model
    t.is(service.get('agent.model'), 'cli-model');

    // Default for agent.reasoningEffort since not in CLI
    t.is(service.get('agent.reasoningEffort'), 'default');

    // Env should override for shell.timeout
    t.is(service.get('shell.timeout'), 60000);

    // Default for shell.maxOutputLines since not in env
    t.is(service.get('shell.maxOutputLines'), 1000);
});

test('getSource() returns default when setting not overridden', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    t.is(service.getSource('agent.model'), 'default');
    t.is(service.getSource('shell.timeout'), 'default');
    t.is(service.getSource('ui.historySize'), 'default');
});

test('validates enum values', async t => {
    const settingsDir = getTestSettingsDir();

    // Create a config file with invalid enum value
    const configFile = path.join(settingsDir, 'settings.json');
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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
    t.is(service.get('agent.reasoningEffort'), 'default');
});

test('respects disableLogging flag', async t => {
    const settingsDir = getTestSettingsDir();
    const service = new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    service.set('agent.model', 'gpt-4o');

    // Should not throw
    t.pass();
});

test('updates config file when new settings are added', async t => {
    const settingsDir = getTestSettingsDir();
    const configFile = path.join(settingsDir, 'settings.json');

    // Create a minimal config file without the 'provider' field
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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
    t.is(service.get('agent.provider'), 'openai');

    // Verify the file was updated with the new setting
    const updatedContent = fs.readFileSync(configFile, 'utf-8');
    const updatedConfig = JSON.parse(updatedContent);

    t.is(updatedConfig.agent.provider, 'openai');
});

test('does not update config file when no new settings are added', async t => {
    const settingsDir = getTestSettingsDir();
    const configFile = path.join(settingsDir, 'settings.json');

    // Create a complete config file with all current settings
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
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
            maxOutputChars: 10000,
        },
        ui: {
            historySize: 1000,
        },
        logging: {
            logLevel: 'info',
            disableLogging: false,
            debugLogging: false,
        },
        environment: {
            nodeEnv: undefined,
        },
        app: {
            shellPath: undefined,
        },
        tools: {
            logFileOperations: true,
        },
        debug: {
            debugBashTool: false,
        },
    };

    fs.writeFileSync(configFile, JSON.stringify(originalConfig), 'utf-8');
    const originalModTime = fs.statSync(configFile).mtime.getTime();

    // Wait a bit to ensure time difference would be detectable
    await new Promise(resolve => setTimeout(resolve, 100));

    // Initialize service - it should NOT update the file since all settings are present
    new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    const newModTime = fs.statSync(configFile).mtime.getTime();

    // File modification time should be the same or within a small margin (not updated)
    t.is(originalModTime, newModTime);
});

test('does not update config file when format differs but content is same', async t => {
    const settingsDir = getTestSettingsDir();
    const configFile = path.join(settingsDir, 'settings.json');

    // Create directory
    if (!fs.existsSync(settingsDir)) {
        fs.mkdirSync(settingsDir, {recursive: true});
    }

    // Write config with compact JSON (no formatting, different key order)
    const compactConfig = {
        agent: {model: 'gpt-4o', reasoningEffort: 'default', maxTurns: 20, retryAttempts: 2, provider: 'openai', openrouter: {}},
        shell: {timeout: 120000, maxOutputLines: 1000, maxOutputChars: 10000},
        ui: {historySize: 1000},
        logging: {logLevel: 'info', disableLogging: false, debugLogging: false},
        environment: {nodeEnv: undefined},
        app: {shellPath: undefined},
        tools: {logFileOperations: true},
        debug: {debugBashTool: false},
    };

    fs.writeFileSync(configFile, JSON.stringify(compactConfig), 'utf-8');
    const originalModTime = fs.statSync(configFile).mtime.getTime();

    await new Promise(resolve => setTimeout(resolve, 100));

    // Initialize service - it should NOT update the file even though format differs
    new SettingsService({
        settingsDir,
        disableLogging: true,
    });

    const newModTime = fs.statSync(configFile).mtime.getTime();

    // File modification time should be the same (not updated despite format difference)
    t.is(originalModTime, newModTime);
});
