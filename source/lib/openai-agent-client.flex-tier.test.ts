import { it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsService } from '../services/settings/settings-service.js';
import { SETTING_KEYS } from '../services/settings/settings-service.js';

const TEST_BASE_DIR = path.join(os.tmpdir(), `term2-test-settings-flex-${Math.random().toString(36).slice(2)}`);
let testCounter = 0;

const getTestSettingsDir = () => {
  testCounter += 1;
  return path.join(TEST_BASE_DIR, `test-${testCounter}`);
};

afterAll(() => {
  if (fs.existsSync(TEST_BASE_DIR)) {
    fs.rmSync(TEST_BASE_DIR, { recursive: true, force: true });
  }
});

it('OpenAI Flex Service Tier setting can be enabled', () => {
  const settings = new SettingsService({
    settingsDir: getTestSettingsDir(),
    disableFilePersistence: true,
    disableLogging: true,
  });

  // Enable Flex Service Tier
  settings.set(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER, true);

  // Verify the setting is stored correctly
  const value = settings.get<boolean>(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER);
  expect(value).toBe(true);
});

it('OpenAI Flex Service Tier setting is disabled by default', () => {
  const settings = new SettingsService({
    settingsDir: getTestSettingsDir(),
    disableFilePersistence: true,
    disableLogging: true,
  });

  // Verify the default value is false
  const value = settings.get<boolean>(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER);
  expect(value).toBe(false);
});

it('OpenAI Flex Service Tier setting can be disabled', () => {
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
  expect(value).toBe(false);
});

it('OpenAI Flex Service Tier setting is runtime modifiable', () => {
  const settings = new SettingsService({
    settingsDir: getTestSettingsDir(),
    disableFilePersistence: true,
    disableLogging: true,
  });

  // Verify the setting is runtime modifiable
  expect(settings.isRuntimeModifiable(SETTING_KEYS.AGENT_USE_FLEX_SERVICE_TIER)).toBe(true);
});

it('OpenAI Flex Service Tier setting is included in getAll()', () => {
  const settings = new SettingsService({
    settingsDir: getTestSettingsDir(),
    disableFilePersistence: true,
    disableLogging: true,
  });

  const allSettings = settings.getAll();

  // Verify the setting is present in the returned object
  expect(allSettings.agent.useFlexServiceTier).toBeTruthy();
  expect(allSettings.agent.useFlexServiceTier.value).toBe(false);
  // Source can be 'default' or 'config' depending on whether a settings file exists
  expect(['default', 'config'].includes(allSettings.agent.useFlexServiceTier.source)).toBe(true);
});
