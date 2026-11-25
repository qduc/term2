// The settings.json `version` field and what a startup writes, through the built CLI and a real
// settings directory (src/config/settings/file/settings-file-version.ts; Contract 10).
//
// `--list-models` is the launch here because it loads settings with file persistence on and needs
// no terminal: a headless prompt never writes settings.json, so it cannot show a startup migration.
// One launch per case; the newer-version case adds a headless prompt to show the refusal there too.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { integrationCliPath } from '../helpers/integration-cli.js';
import { createWorld, removeWorld, runCli, type World } from '../helpers/loopback-chat-world.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { startRefusingProxy, type RefusingProxy } from '../../scripts/provider-black-box/grok-fixture.js';

type Json = Record<string, any>;

/** Written before the version field existed; read only, never edited (tests/fixtures/release-data/README.md). */
const LEGACY_SETTINGS = fileURLToPath(
  new URL('../fixtures/release-data/1.4.0/settings/settings.json', import.meta.url),
);
/** The version this build writes (SETTINGS_FILE_VERSION), stated here so a change to it is a visible test change. */
const CURRENT_VERSION = 1;
const LIST_MODELS = ['--list-models', 'no-model-matches-this'];

let world: World;
let proxy: RefusingProxy;
let settingsDir = '';
let settingsFile = '';

beforeEach(async () => {
  world = createWorld('term2-settings-version');
  // The model listing reaches for provider catalogues; refuse every outbound HTTPS request.
  proxy = await startRefusingProxy();
  // Settings are written to disk only outside test mode (isTestEnvironment), as in settings-reset.e2e.
  world = { ...world, env: { ...world.env, ...proxy.env, NODE_ENV: 'production', VITEST: undefined } };
  settingsDir = resolveSettingsDirectory({ homeDir: world.home, env: world.env });
  settingsFile = path.join(settingsDir, 'settings.json');
});
afterEach(async () => {
  await proxy.close().catch(() => undefined);
  removeWorld(world);
});

const readSettings = (): Json => JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Json;
const run = (args: string[]) => runCli(world, integrationCliPath(), args);
const describeRun = (result: { status: number | null; stdout: string; stderr: string }) =>
  `exit=${result.status}\nstdout=${result.stdout.slice(-600)}\nstderr=${result.stderr.slice(-600)}`;

/** Every value in `saved` is in `now` unchanged (keys may be added, never lost). */
function expectNothingLost(saved: unknown, now: unknown, where = 'settings.json'): void {
  if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
    expect(now, `${where} is no longer an object`).toBeTypeOf('object');
    for (const [key, value] of Object.entries(saved as Json)) {
      expect(Object.keys(now as Json), `${where} lost ${key}`).toContain(key);
      expectNothingLost(value, (now as Json)[key], `${where}.${key}`);
    }
    return;
  }
  expect(now, `${where} changed`).toEqual(saved);
}

describe('settings.json version', () => {
  it('a fresh install leaves the memory directory and model choice unset on disk', async () => {
    const result = await run(LIST_MODELS);
    expect(result.stderr, describeRun(result)).not.toMatch(/settings/i);

    const written = readSettings();
    expect(written.version).toBe(CURRENT_VERSION);
    expect(written.agent).not.toHaveProperty('modelSelection');
    expect(written.memory).toEqual({
      enabled: true,
      contextBudgetChars: 8000,
      searchDefaultLimit: 10,
      searchMaxLimit: 50,
    });
    expect(fs.readFileSync(settingsFile, 'utf8')).not.toContain(world.home);
    await run(LIST_MODELS);
    expect(readSettings().agent).not.toHaveProperty('modelSelection');
  });

  it('migrates an unversioned 1.4.0 file to the current version and keeps every saved value', async () => {
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.copyFileSync(LEGACY_SETTINGS, settingsFile);
    const saved = readSettings();
    expect(saved).not.toHaveProperty('version');

    const result = await run(LIST_MODELS);
    expect(result.stderr, describeRun(result)).not.toMatch(/settings/i);

    const migrated = readSettings();
    expect(migrated.version).toBe(CURRENT_VERSION);
    // Includes memory.directory: the snapshot's path is another machine's, and an existing value is kept.
    expectNothingLost(saved, migrated);
    expect(migrated.memory.directory).toBe(saved.memory.directory);
  });

  it('refuses a file from a newer version by name and leaves it byte-for-byte unchanged', async () => {
    fs.mkdirSync(settingsDir, { recursive: true });
    const legacy = JSON.parse(fs.readFileSync(LEGACY_SETTINGS, 'utf8')) as Json;
    const bytes = JSON.stringify({ ...legacy, version: CURRENT_VERSION + 1 }, null, 2);
    fs.writeFileSync(settingsFile, bytes);

    for (const args of [LIST_MODELS, ['--profile', 'bare', 'Say hello']]) {
      const result = await run(args);
      expect(result.status, describeRun(result)).toBe(1);
      expect(result.stderr, describeRun(result)).toContain(
        `it is settings version ${CURRENT_VERSION + 1}, written by a newer Term2; ` +
          `this build reads settings up to version ${CURRENT_VERSION}.`,
      );
      expect(fs.readFileSync(settingsFile, 'utf8')).toBe(bytes);
    }
    // No quarantine sibling, lock or temporary file was left beside it.
    expect(fs.readdirSync(settingsDir)).toEqual(['settings.json']);
    expect(proxy.connects, 'a refused start made no outbound request').toEqual([]);
  });

  it('still quarantines a salvageable corrupt file and writes a current-version replacement', async () => {
    fs.mkdirSync(settingsDir, { recursive: true });
    const corrupt = `crash fragment before the JSON\n${fs.readFileSync(LEGACY_SETTINGS, 'utf8')}`;
    fs.writeFileSync(settingsFile, corrupt);

    const result = await run(LIST_MODELS);
    expect(result.stderr, describeRun(result)).not.toMatch(/Failed to parse settings/);

    const siblings = fs.readdirSync(settingsDir).sort();
    const quarantined = siblings.filter((name) => name.startsWith('settings.json.corrupt-'));
    expect(siblings, 'one quarantine file beside the replacement').toEqual(['settings.json', ...quarantined]);
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(settingsDir, quarantined[0]!), 'utf8')).toBe(corrupt);
    expect(readSettings().version).toBe(CURRENT_VERSION);
  });
});
