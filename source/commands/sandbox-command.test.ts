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

it.each([
  {
    title: 'true to false',
    initialSandbox: true,
    expectedSandbox: false,
    initialMode: 'off',
    expectedMode: 'off',
    messageParts: ['disabled', 'unrestricted access'],
  },
  {
    title: 'false to true',
    initialSandbox: false,
    expectedSandbox: true,
    initialMode: 'off',
    expectedMode: 'off',
    messageParts: ['enabled', 'secure environment'],
  },
  {
    title: 'false to true demotes always mode',
    initialSandbox: false,
    expectedSandbox: true,
    initialMode: 'always',
    expectedMode: 'advisory',
    messageParts: ['enabled', 'secure environment', 'demoted to advisory'],
  },
])(
  'action toggles sandbox.enabled from $title',
  ({ initialSandbox, expectedSandbox, initialMode, expectedMode, messageParts }) => {
    const settings: Record<string, boolean | string> = {
      'sandbox.enabled': initialSandbox,
      'shell.autoApproveMode': initialMode,
    };
    const appliedSettings: Record<string, unknown> = {};
    const messages: string[] = [];

    const cmd = createSandboxSlashCommand({
      settingsService: {
        get: (key: string) => settings[key],
        set: (key: string, value: boolean | string) => {
          settings[key] = value;
          if (key === 'sandbox.enabled' && value === true && initialMode === 'always') {
            settings['shell.autoApproveMode'] = 'advisory';
          }
        },
      } as unknown as SettingsService,
      applyRuntimeSetting: (key: string, value: unknown) => {
        appliedSettings[key] = value;
      },
      addSystemMessage: (message: string) => messages.push(message),
    });

    expect(cmd.action()).toBe(true);
    expect(settings['sandbox.enabled']).toBe(expectedSandbox);
    expect(settings['shell.autoApproveMode']).toBe(expectedMode);
    expect(appliedSettings['sandbox.enabled']).toBe(expectedSandbox);
    expect(messages).toHaveLength(1);
    for (const messagePart of messageParts) {
      expect(messages[0]).toContain(messagePart);
    }
  },
);
