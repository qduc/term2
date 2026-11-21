import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDirectConfigSettings, recordDirectConfigSettings } from '../../src/app/config-settings.js';
import { SettingsService } from '../../src/app/settings-service.js';
import { DEFAULT_SETTINGS } from '../../src/config/settings/settings-schema.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-approval-settings-'));
  directories.push(settingsDir);
  const settingsFile = path.join(settingsDir, 'settings.json');
  const write = (settings: unknown) => fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const open = () => new SettingsService({ settingsDir, disableLogging: true, disableFilePersistence: false });
  return { write, read, open };
}

it('migrates saved advisory before validation and durably rewrites a complete snapshot', () => {
  const file = fixture();
  file.write({ ...DEFAULT_SETTINGS, shell: { ...DEFAULT_SETTINGS.shell, autoApproveMode: 'advisory' } });
  const settings = file.open();
  expect(settings.get('shell.autoApproveMode')).toBe('off');
  expect(settings.get('shell.showReview')).toBe(true);
  expect(settings.getSource('shell.showReview')).toBe('config');
  expect(file.read().shell).toMatchObject({ autoApproveMode: 'off', showReview: true });
  const restarted = file.open();
  expect(restarted.get('shell.autoApproveMode')).toBe('off');
  expect(restarted.get('shell.showReview')).toBe(true);
  expect(() => restarted.setDynamic('shell.autoApproveMode', 'advisory')).toThrow('shell.showReview=true');
  expect(file.read().shell.autoApproveMode).toBe('off');
});

it('migrates a peer-replaced advisory file again inside a locked save without losing its settings', () => {
  const file = fixture();
  const settings = file.open();
  file.write({ shell: { autoApproveMode: 'advisory' }, sandbox: { enabled: true }, ui: { theme: 'dark' } });
  expect(settings.setPersistentDynamic('tools.web.enabled', false)).toEqual({ status: 'saved' });
  expect(file.read()).toMatchObject({
    shell: { autoApproveMode: 'off', showReview: true },
    sandbox: { enabled: true },
    tools: { web: { enabled: false } },
    ui: { theme: 'dark' },
  });
  expect(file.open().get('shell.showReview')).toBe(true);
});

it('preserves independent sandbox preferences through mode writes, overlays, transactions and restart', () => {
  const file = fixture();
  file.write({ sandbox: { enabled: true }, shell: { autoApproveMode: 'always' } });
  const settings = file.open();
  expect(settings.get('shell.autoApproveMode')).toBe('always');
  expect(settings.get('sandbox.enabled')).toBe(true);
  for (const sandbox of [false, true]) {
    settings.set('sandbox.enabled', sandbox);
    for (const mode of ['off', 'auto', 'unattended', 'always'] as const) {
      settings.set('shell.autoApproveMode', mode);
      expect(file.read().sandbox.enabled).toBe(sandbox);
      expect(settings.get('sandbox.enabled')).toBe(sandbox);
      const prepared = createDirectConfigSettings(settings, { approvalMode: mode });
      expect(prepared.settings.get('sandbox.enabled')).toBe(sandbox);
      expect(prepared.settings.get('shell.autoApproveMode')).toBe(mode);
      recordDirectConfigSettings(settings, prepared.intent, 'builtin:bare', { persist: false, approvalMode: mode });
      expect(settings.get('sandbox.enabled')).toBe(sandbox);
      expect(settings.get('shell.autoApproveMode')).toBe(mode);
    }
  }
  settings.set('sandbox.enabled', false);
  settings.set('sandbox.enabled', true);
  expect(settings.get('shell.autoApproveMode')).toBe('always');
  settings.set('shell.autoApproveMode', 'auto', { persist: false });
  settings.setPersistentDynamic('ui.theme', 'dark');
  expect(settings.get('sandbox.enabled')).toBe(true);
  expect(settings.get('shell.autoApproveMode')).toBe('auto');
  expect(file.read().shell.autoApproveMode).toBe('always');
  expect(
    settings.setPersistentDynamicTransaction([
      { key: 'shell.autoApproveMode', value: 'always' },
      { key: 'sandbox.enabled', value: true },
      { key: 'shell.showReview', value: true },
    ]),
  ).toEqual({ status: 'saved' });
  const restarted = file.open();
  expect(restarted.get('shell.autoApproveMode')).toBe('always');
  expect(restarted.get('sandbox.enabled')).toBe(true);
  expect(restarted.get('shell.showReview')).toBe(true);
  restarted.reset('sandbox.enabled');
  expect(restarted.get('shell.autoApproveMode')).toBe('always');
});

it('refuses a peer-replaced invalid settings file without overwriting its bytes', () => {
  const file = fixture();
  const settings = file.open();
  const invalid = { shell: { autoApproveMode: 'unknown' } };
  file.write(invalid);
  expect(settings.setPersistentDynamic('shell.showReview', true)).toEqual({
    status: 'not-persisted',
    reason: 'failed',
  });
  expect(file.read()).toEqual(invalid);
});
