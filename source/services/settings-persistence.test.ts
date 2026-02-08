import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SettingsSchema, DEFAULT_SETTINGS } from './settings-schema.js';
import {
  hasMissingKeys,
  loadSettingsFromFile,
  saveSettingsToFile,
  stripSensitiveSettings,
} from './settings-persistence.js';

test('stripSensitiveSettings: removes shellPath and openrouter secrets', (t) => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.app.shellPath = '/bin/zsh';
  settings.agent.openrouter = {
    apiKey: 'secret',
    baseUrl: 'https://example.com',
    referrer: 'x',
    title: 'y',
  };

  const cleaned = stripSensitiveSettings(settings);
  t.is((cleaned as any).app?.shellPath, undefined);
  t.is((cleaned as any).agent?.openrouter, undefined);
});

test('hasMissingKeys: true when defaults introduce new key', (t) => {
  const target = { a: { b: 1 } };
  const source = { a: { b: 1, c: 2 } };
  t.true(hasMissingKeys(target, source, new Set()));
});

test('loadSettingsFromFile: returns empty validated when schema rejects', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ agent: { maxTurns: -1 } }, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  t.deepEqual(out.validated, {});
  t.deepEqual(out.raw, { agent: { maxTurns: -1 } });
});

test('saveSettingsToFile: writes stripped settings', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.app.shellPath = '/bin/zsh';

  saveSettingsToFile({
    settingsDir: dir,
    settings,
    stripSensitiveSettings,
    disableLogging: true,
  });

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
  t.is(written.app?.shellPath, undefined);
});
