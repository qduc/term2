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

test('loadSettingsFromFile: preserves valid sections when another section has an invalid value', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // agent section is invalid (maxTurns must be positive); app section is valid
  const raw = { agent: { maxTurns: -1 }, app: { liteMode: true } };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  // Valid app section is preserved; invalid agent section is omitted (falls back to defaults)
  t.is((out.validated as any)?.app?.liteMode, true);
  t.is((out.validated as any)?.agent, undefined);
  t.true(out.hadErrors);
  t.deepEqual(out.raw, raw);
});

test('loadSettingsFromFile: falls back to default for a section containing invalid array items', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  // providers array is invalid (one item has unknown type); app section is valid
  const raw = {
    providers: [
      { name: 'good', type: 'openai-compatible', baseUrl: 'https://api.example.com' },
      { name: 'bad', type: 'unknown-type' },
    ],
    app: { liteMode: true },
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  // Entire providers section falls back to default; valid app section is preserved
  t.is((out.validated as any)?.providers, undefined);
  t.is((out.validated as any)?.app?.liteMode, true);
  t.true(out.hadErrors);
  t.deepEqual(out.raw, raw);
});

test('loadSettingsFromFile: returns empty validated when top-level value is not an object', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify('not-an-object'), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  t.deepEqual(out.validated, {});
  t.true(out.hadErrors);
  t.is(out.raw, 'not-an-object');
});

test('loadSettingsFromFile: hadErrors is false when file is valid', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ app: { liteMode: true } }, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  t.false(out.hadErrors);
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
