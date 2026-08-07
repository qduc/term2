import { it, expect } from 'vitest';
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

it('stripSensitiveSettings: removes shellPath and openrouter secrets, preserving apiKey', () => {
  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.app.shellPath = '/bin/zsh';
  settings.agent.openrouter = {
    apiKey: 'secret',
    baseUrl: 'https://example.com',
    referrer: 'x',
    title: 'y',
  };

  const cleaned = stripSensitiveSettings(settings);
  expect(cleaned.app?.shellPath).toBe(undefined);
  expect(cleaned.agent?.openrouter).toEqual({ apiKey: 'secret' });
});

it('hasMissingKeys: true when defaults introduce new key', () => {
  const target = { a: { b: 1 } };
  const source = { a: { b: 1, c: 2 } };
  expect(hasMissingKeys(target, source, new Set())).toBe(true);
});

it('loadSettingsFromFile: preserves valid sections when another section has an invalid value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(dir, { recursive: true, force: true })) needs manual try/finally conversion;

  // agent section is invalid (maxTurns must be positive); app section is valid
  const raw = { agent: { maxTurns: -1 }, app: { liteMode: true } };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  // Valid app section is preserved; invalid agent section is omitted (falls back to defaults)
  expect(out.validated.app?.liteMode).toBe(true);
  expect(out.validated.agent).toBe(undefined);
  expect(out.hadErrors).toBe(true);
  expect(out.raw).toEqual(raw);
});

it('loadSettingsFromFile: falls back to default for a section containing invalid array items', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(dir, { recursive: true, force: true })) needs manual try/finally conversion;

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
  expect(out.validated.providers).toBe(undefined);
  expect(out.validated.app?.liteMode).toBe(true);
  expect(out.hadErrors).toBe(true);
  expect(out.raw).toEqual(raw);
});

it('loadSettingsFromFile: returns empty validated when top-level value is not an object', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(dir, { recursive: true, force: true })) needs manual try/finally conversion;

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify('not-an-object'), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.validated).toEqual({});
  expect(out.hadErrors).toBe(true);
  expect(out.raw).toBe('not-an-object');
});

it('loadSettingsFromFile: hadErrors is false when file is valid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(dir, { recursive: true, force: true })) needs manual try/finally conversion;

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ app: { liteMode: true } }, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.hadErrors).toBe(false);
});

it('loadSettingsFromFile: hadErrors is true when file contains invalid JSON syntax', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));

  fs.writeFileSync(path.join(dir, 'settings.json'), 'invalid json {', 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.hadErrors).toBe(true);
  expect(out.errorDetails).toBeDefined();
  expect(out.errorDetails?.length).toBeGreaterThan(0);
});

it('saveSettingsToFile: writes stripped settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(dir, { recursive: true, force: true })) needs manual try/finally conversion;

  const settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  settings.app.shellPath = '/bin/zsh';

  saveSettingsToFile({
    settingsDir: dir,
    schema: SettingsSchema,
    defaults: DEFAULT_SETTINGS,
    mutate: () => settings,
    stripSensitiveSettings,
    disableLogging: true,
  });

  const written = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'));
  expect(written.app?.shellPath).toBe(undefined);
});

it('saveSettingsToFile: recovers a stale lock and leaves a complete JSON document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  const lockFile = path.join(dir, 'settings.json.lock');
  fs.writeFileSync(lockFile, 'abandoned', 'utf-8');
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, staleAt, staleAt);

  saveSettingsToFile({
    settingsDir: dir,
    schema: SettingsSchema,
    defaults: DEFAULT_SETTINGS,
    mutate: (current) => ({ ...current, agent: { ...current.agent, model: 'gpt-4o' } }),
    stripSensitiveSettings,
    disableLogging: true,
  });

  expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).agent.model).toBe('gpt-4o');
  expect(fs.existsSync(lockFile)).toBe(false);
  expect(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
});

it('saveSettingsToFile: gives up on a live lock without overwriting its settings file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ agent: { model: 'gpt-5.1' } }), 'utf-8');
  fs.writeFileSync(path.join(dir, 'settings.json.lock'), 'active', 'utf-8');

  const result = saveSettingsToFile({
    settingsDir: dir,
    schema: SettingsSchema,
    defaults: DEFAULT_SETTINGS,
    mutate: (current) => ({ ...current, agent: { ...current.agent, model: 'gpt-4o' } }),
    stripSensitiveSettings,
    disableLogging: true,
    lockOptions: { timeoutMs: 0 },
  });

  expect(result).toBe(undefined);
  expect(JSON.parse(fs.readFileSync(settingsFile, 'utf-8')).agent.model).toBe('gpt-5.1');
});
