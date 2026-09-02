import { it, expect, vi } from 'vitest';
import { createAutoApproveSlashCommand } from './auto-approve-command.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { AUTO_APPROVE_TRIGGER } from '../components/input/triggers.js';

function createHarness(initialMode = 'off') {
  const settings: Record<string, string> = { 'shell.autoApproveMode': initialMode };
  const applied: Record<string, unknown> = {};
  const messages: string[] = [];
  const replaceInput = vi.fn();
  const cmd = createAutoApproveSlashCommand({
    settingsService: {
      get: (key: string) => settings[key],
      set: (key: string, value: string) => {
        settings[key] = value;
      },
    } as unknown as SettingsService,
    applyRuntimeSetting: (key, value) => {
      applied[key] = value;
    },
    addSystemMessage: (message) => messages.push(message),
    replaceInput,
  });

  return { cmd, settings, applied, messages, replaceInput };
}

it('createAutoApproveSlashCommand returns a command with correct metadata', () => {
  const { cmd } = createHarness();

  expect(cmd.name).toBe('auto-approve');
  expect(cmd.description).toBe('Set tool auto-approval mode (off, advisory, auto, always)');
  expect(cmd.expectsArgs).toBe(true);
  expect(cmd.completion).toEqual({
    type: 'setting-value',
    trigger: AUTO_APPROVE_TRIGGER,
    settingKey: 'shell.autoApproveMode',
  });
});

it('action with empty args triggers value selection menu via replaceInput', () => {
  const { cmd, settings, applied, messages, replaceInput } = createHarness();

  const resultEmpty = cmd.action('');
  expect(resultEmpty).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(AUTO_APPROVE_TRIGGER);
  expect(settings['shell.autoApproveMode']).toBe('off');
  expect(applied).toEqual({});
  expect(messages).toEqual([]);

  replaceInput.mockClear();
  const resultUndefined = cmd.action();
  expect(resultUndefined).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(AUTO_APPROVE_TRIGGER);

  replaceInput.mockClear();
  const resultWhitespace = cmd.action('   ');
  expect(resultWhitespace).toBe(false);
  expect(replaceInput).toHaveBeenCalledWith(AUTO_APPROVE_TRIGGER);
});

it('action with valid mode updates settings and applies runtime setting', () => {
  const { cmd, settings, applied, messages } = createHarness();

  const result = cmd.action('auto');
  expect(result).toBe(true);
  expect(settings['shell.autoApproveMode']).toBe('auto');
  expect(applied['shell.autoApproveMode']).toBe('auto');
  expect(messages).toEqual(['Tool auto-approval mode set to: AUTO']);
});

it('action with always mode shows special YOLO warning', () => {
  const { cmd, settings, applied, messages } = createHarness();

  const result = cmd.action('always');
  expect(result).toBe(true);
  expect(settings['shell.autoApproveMode']).toBe('always');
  expect(applied['shell.autoApproveMode']).toBe('always');
  expect(messages[0]).toContain('ALWAYS');
  expect(messages[0]).toContain('Sandbox disabled');
});

it('action handles mixed case and surrounding whitespace', () => {
  const { cmd, settings, applied, messages } = createHarness();

  const result = cmd.action('  Advisory  ');
  expect(result).toBe(true);
  expect(settings['shell.autoApproveMode']).toBe('advisory');
  expect(applied['shell.autoApproveMode']).toBe('advisory');
  expect(messages).toEqual(['Tool auto-approval mode set to: ADVISORY']);
});

it('action with invalid mode returns error message and does not change settings', () => {
  const { cmd, settings, applied, messages } = createHarness();

  const result = cmd.action('super-auto');
  expect(result).toBe(false);
  expect(settings['shell.autoApproveMode']).toBe('off');
  expect(applied['shell.autoApproveMode']).toBeUndefined();
  expect(messages[0]).toContain("Invalid mode 'super-auto'");
});
