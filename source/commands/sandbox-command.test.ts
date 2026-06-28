import { it, expect } from 'vitest';
import { createSandboxSlashCommand } from '../commands/sandbox-command.js';
import type { SettingsService } from '../services/settings/settings-service.js';

it('createSandboxSlashCommand returns a command with correct metadata', () => {
  const cmd = createSandboxSlashCommand({
    settingsService: { get: () => true } as unknown as SettingsService,
    applyRuntimeSetting: () => {},
    addSystemMessage: () => {},
  });

  expect(cmd.name).toBe('sandbox');
  expect(cmd.description).toBe('Toggle shell sandbox mode (restricts shell operations to a secure environment)');
});

it('action toggles sandbox.enabled from true to false', () => {
  const settings: { [key: string]: boolean } = { 'sandbox.enabled': true };
  const appliedSettings: { [key: string]: any } = {};
  const messages: string[] = [];

  const cmd = createSandboxSlashCommand({
    settingsService: {
      get: (key: string) => settings[key],
      set: (key: string, value: boolean) => {
        settings[key] = value;
      },
    } as unknown as SettingsService,
    applyRuntimeSetting: (key: string, value: any) => {
      appliedSettings[key] = value;
    },
    addSystemMessage: (msg: string) => messages.push(msg),
  });

  const result = cmd.action();
  expect(result).toBe(true);
  expect(settings['sandbox.enabled']).toBe(false);
  expect(appliedSettings['sandbox.enabled']).toBe(false);
  expect(messages.length).toBe(1);
  expect(messages[0]).toContain('disabled');
  expect(messages[0]).toContain('unrestricted access');
});

it('action toggles sandbox.enabled from false to true', () => {
  const settings: { [key: string]: boolean } = { 'sandbox.enabled': false };
  const appliedSettings: { [key: string]: any } = {};
  const messages: string[] = [];

  const cmd = createSandboxSlashCommand({
    settingsService: {
      get: (key: string) => settings[key],
      set: (key: string, value: boolean) => {
        settings[key] = value;
      },
    } as unknown as SettingsService,
    applyRuntimeSetting: (key: string, value: any) => {
      appliedSettings[key] = value;
    },
    addSystemMessage: (msg: string) => messages.push(msg),
  });

  const result = cmd.action();
  expect(result).toBe(true);
  expect(settings['sandbox.enabled']).toBe(true);
  expect(appliedSettings['sandbox.enabled']).toBe(true);
  expect(messages.length).toBe(1);
  expect(messages[0]).toContain('enabled');
  expect(messages[0]).toContain('secure environment');
});
