import test from 'ava';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SettingsService} from '../services/settings-service.js';
import {SETTING_KEYS} from '../services/settings-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_BASE_DIR = path.join(__dirname, '../../test-settings-flex');
let testCounter = 0;

const getTestSettingsDir = () => {
    testCounter += 1;
    return path.join(TEST_BASE_DIR, `test-${testCounter}`);
};

test('OpenAI Flex Service Tier setting can be enabled', t => {
    const settings = new SettingsService({
        settingsDir: getTestSettingsDir(),
        disableFilePersistence: true,
        disableLogging: true,
    });

    // Enable Flex Service Tier
    settings.set(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER, true);

    // Verify the setting is stored correctly
    const value = settings.get<boolean>(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER);
    t.is(value, true);
});

test('OpenAI Flex Service Tier setting is disabled by default', t => {
    const settings = new SettingsService({
        settingsDir: getTestSettingsDir(),
        disableFilePersistence: true,
        disableLogging: true,
    });

    // Verify the default value is false
    const value = settings.get<boolean>(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER);
    t.is(value, false);
});

test('OpenAI Flex Service Tier setting can be disabled', t => {
    const settings = new SettingsService({
        settingsDir: getTestSettingsDir(),
        disableFilePersistence: true,
        disableLogging: true,
    });

    // Enable then disable
    settings.set(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER, true);
    settings.set(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER, false);

    // Verify the setting is false
    const value = settings.get<boolean>(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER);
    t.is(value, false);
});

test('OpenAI Flex Service Tier setting is runtime modifiable', t => {
    const settings = new SettingsService({
        settingsDir: getTestSettingsDir(),
        disableFilePersistence: true,
        disableLogging: true,
    });

    // Verify the setting is runtime modifiable
    t.true(settings.isRuntimeModifiable(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER));
});

test('OpenAI Flex Service Tier setting is included in getAll()', t => {
    const settings = new SettingsService({
        settingsDir: getTestSettingsDir(),
        disableFilePersistence: true,
        disableLogging: true,
    });

    const allSettings = settings.getAll();

    // Verify the setting is present in the returned object
    t.truthy(allSettings.agent.useFlexServiceTier);
    t.is(allSettings.agent.useFlexServiceTier.value, false);
    // Source can be 'default' or 'config' depending on whether a settings file exists
    t.true(['default', 'config'].includes(allSettings.agent.useFlexServiceTier.source));
});
