import { it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SettingsSchema, DEFAULT_SETTINGS } from './settings-schema.js';
import {
  acquireSettingsLock,
  hasMissingKeys,
  loadSettingsFromFile,
  saveSettingsToFile,
  scanForRecoverableJson,
  stripSensitiveSettings,
} from './settings-persistence.js';

const tempDirs: string[] = [];
const legacySelections = {
  model: 'legacy-main',
  provider: 'anthropic',
  smartModel: 'smart',
  smartProvider: 'codex',
  balancedModel: ['balanced', { model: 'pinned', provider: 'zai' }],
  mentorModel: 'mentor',
  mentorProvider: 'openrouter',
  mentorPool: ['sample', { model: 'second', reasoningEffort: 'high' }],
  subagentExplorerModel: 'explorer',
  subagentExplorerProvider: 'google',
  autoApproveModel: 'approval',
  autoApproveProvider: 'openai',
};

it('migrates persisted legacy selections before validation and the locked save reload', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'settings.json');
  const raw = { agent: legacySelections };
  fs.writeFileSync(file, JSON.stringify(raw));
  const loaded = loadSettingsFromFile({ settingsDir: dir, schema: SettingsSchema, disableLogging: true });
  expect(loaded.hadErrors).toBe(false);
  expect(loaded.raw).toEqual(raw);
  expect(loaded.validated.agent).toMatchObject({
    modelSelection: { model: 'legacy-main', provider: 'anthropic' },
    smartModel: [{ model: 'smart', provider: 'codex' }],
    balancedModel: [
      { model: 'balanced', provider: 'anthropic' },
      { model: 'pinned', provider: 'zai' },
    ],
    cheapModel: [{ model: 'explorer', provider: 'google' }],
    choreModel: [{ model: 'approval', provider: 'openai' }],
    mentorPool: [
      { model: 'sample', provider: 'openrouter' },
      { model: 'second', provider: 'openrouter', reasoningEffort: 'high' },
    ],
  });
  const saved = saveSettingsToFile({
    settingsDir: dir,
    schema: SettingsSchema,
    defaults: DEFAULT_SETTINGS,
    mutate: (current) => current,
    stripSensitiveSettings,
    disableLogging: true,
  });
  expect(saved).toBeDefined();
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(SettingsSchema.safeParse(persisted).success).toBe(true);
  expect(persisted.agent).not.toHaveProperty('model');
  expect(persisted.agent).not.toHaveProperty('mentorProvider');
  expect(persisted.agent.smartModel).toEqual(loaded.validated.agent?.smartModel);
});

it.each([
  { model: 42 },
  { provider: null },
  { smartModel: '' },
  { smartProvider: 42 },
  { mentorModel: null },
  { mentorPool: [{ model: 'mentor', provider: null }] },
  { capableModel: { model: 'incomplete' } },
  { subagentWorkerModel: false },
  { modelSelection: { model: 'incomplete' }, model: 'valid', provider: 'openai' },
])('does not overwrite malformed legacy selections: %j', (agent) => {
  const dir = makeTempDir();
  const file = path.join(dir, 'settings.json');
  const content = JSON.stringify({ agent });
  fs.writeFileSync(file, content);
  expect(loadSettingsFromFile({ settingsDir: dir, schema: SettingsSchema, disableLogging: true }).hadErrors).toBe(true);
  expect(
    saveSettingsToFile({
      settingsDir: dir,
      schema: SettingsSchema,
      defaults: DEFAULT_SETTINGS,
      mutate: (current) => current,
      stripSensitiveSettings,
      disableLogging: true,
    }),
  ).toBeUndefined();
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});

it('preserves explicit canonical selections over valid obsolete role selections', () => {
  const dir = makeTempDir();
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({
      agent: {
        ...legacySelections,
        modelSelection: { model: 'canonical', provider: 'zai' },
        smartModel: [{ model: 'canonical-smart', provider: 'google' }],
        mentorPool: [],
      },
    }),
  );
  const loaded = loadSettingsFromFile({ settingsDir: dir, schema: SettingsSchema, disableLogging: true });
  expect(loaded.hadErrors).toBe(false);
  expect(loaded.validated.agent?.modelSelection).toEqual({ model: 'canonical', provider: 'zai' });
  expect(loaded.validated.agent?.smartModel).toEqual([{ model: 'canonical-smart', provider: 'google' }]);
  expect(loaded.validated.agent?.mentorPool).toEqual([]);
});

it.each([
  [
    { agent: { capableModel: 'capable', provider: 'codex', mentorModel: 'mentor', mentorProvider: 'google' } },
    { smartModel: [{ model: 'capable', provider: 'codex' }], mentorPool: [{ model: 'mentor', provider: 'google' }] },
  ],
  [
    { agent: { subagentWorkerModel: 'worker', subagentWorkerProvider: 'zai' } },
    { balancedModel: [{ model: 'worker', provider: 'zai' }] },
  ],
  [
    {
      agent: {
        efficientModel: 'efficient',
        provider: 'google',
        subagentExplorerModel: 'explorer',
        subagentExplorerProvider: 'codex',
      },
    },
    { cheapModel: [{ model: 'efficient', provider: 'google' }] },
  ],
  [
    { agent: { subagentLibrarianModel: { model: 'librarian', provider: 'anthropic' } } },
    { cheapModel: [{ model: 'librarian', provider: 'anthropic' }] },
  ],
  [
    { agent: { provider: 'google' }, tools: { editHealingModel: 'heal', editHealingProvider: 'codex' } },
    { choreModel: [{ model: 'heal', provider: 'codex' }] },
  ],
  [
    { tools: { editHealingModel: { model: 'heal', provider: 'zai' } } },
    { choreModel: [{ model: 'heal', provider: 'zai' }] },
  ],
  [{ agent: { model: 'main', mentorModel: '' } }, { mentorPool: [] }],
])('uses historical role precedence with the winning model own provider: %j', (raw, expected) => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw));
  const loaded = loadSettingsFromFile({ settingsDir: dir, schema: SettingsSchema, disableLogging: true });
  expect(loaded.hadErrors).toBe(false);
  expect(loaded.validated.agent).toMatchObject(expected);
});

it('rejects malformed superseded legacy values rather than dropping them', () => {
  const dir = makeTempDir();
  const raw = {
    agent: { modelSelection: { model: 'main', provider: 'openai' }, choreModel: [] },
    tools: { editHealingModel: 42 },
  };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(raw));
  const loaded = loadSettingsFromFile({ settingsDir: dir, schema: SettingsSchema, disableLogging: true });
  expect(loaded.hadErrors).toBe(true);
  expect(loaded.raw).toEqual(raw);
});

it('still rejects legacy runtime mutations after a migrated locked reload', () => {
  const dir = makeTempDir();
  const file = path.join(dir, 'settings.json');
  const content = JSON.stringify({ agent: legacySelections });
  fs.writeFileSync(file, content);
  expect(
    saveSettingsToFile({
      settingsDir: dir,
      schema: SettingsSchema,
      defaults: DEFAULT_SETTINGS,
      mutate: (current) => Object.assign(current, { agent: { ...current.agent, model: 'runtime-legacy' } }),
      stripSensitiveSettings,
      disableLogging: true,
    }),
  ).toBeUndefined();
  expect(fs.readFileSync(file, 'utf8')).toBe(content);
});
const makeTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-settings-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  tempDirs.length = 0;
});

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
  const dir = makeTempDir();

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
  const dir = makeTempDir();

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
  const dir = makeTempDir();

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
  const dir = makeTempDir();

  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ app: { liteMode: true } }, null, 2), 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.hadErrors).toBe(false);
});

it('loadSettingsFromFile: hadErrors is true when file contains invalid JSON syntax', () => {
  const dir = makeTempDir();

  fs.writeFileSync(path.join(dir, 'settings.json'), 'invalid json {', 'utf-8');

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.hadErrors).toBe(true);
  expect(out.errorDetails).toBeDefined();
  expect(out.errorDetails?.length).toBeGreaterThan(0);
  expect(out.recovery).toBeUndefined();
});

it('loadSettingsFromFile: scan fallback recovers a JSON document from trailing garbage', () => {
  const dir = makeTempDir();

  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    '{"agent":{"modelSelection":{"model":"gpt-5.1","provider":"openai"}},"app":{"liteMode":true}} trailing garbage {',
    'utf-8',
  );

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.hadErrors).toBe(true);
  expect(out.recovery?.recovered).toBe(true);
  expect(out.recovery?.recoveredSectionKeys).toEqual(['agent', 'app']);
  expect(out.validated.agent?.modelSelection.model).toBe('gpt-5.1');
  expect(out.raw).toEqual({
    agent: { modelSelection: { model: 'gpt-5.1', provider: 'openai' } },
    app: { liteMode: true },
  });
});

it('loadSettingsFromFile: scan fallback recovers a JSON document from leading garbage', () => {
  const dir = makeTempDir();

  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    'corrupt log line before the document {"agent":{"modelSelection":{"model":"gpt-5.1","provider":"openai"}}}',
    'utf-8',
  );

  const out = loadSettingsFromFile({
    settingsDir: dir,
    schema: SettingsSchema,
    disableLogging: true,
  });

  expect(out.hadErrors).toBe(true);
  expect(out.recovery?.recovered).toBe(true);
  expect(out.validated.agent?.modelSelection.model).toBe('gpt-5.1');
});

it('scanForRecoverableJson: bounded scan gives up on a pathological all-brackets file', () => {
  const garbage = '{'.repeat(40_000);
  expect(scanForRecoverableJson(garbage)).toBeNull();
});

it('scanForRecoverableJson: returns null when only a non-object value is embedded', () => {
  expect(scanForRecoverableJson('prefix [1, 2, 3] suffix')).toBeNull();
});

it('saveSettingsToFile: writes stripped settings', () => {
  const dir = makeTempDir();

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
  const dir = makeTempDir();
  const lockFile = path.join(dir, 'settings.json.lock');
  fs.writeFileSync(lockFile, 'abandoned', 'utf-8');
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, staleAt, staleAt);

  saveSettingsToFile({
    settingsDir: dir,
    schema: SettingsSchema,
    defaults: DEFAULT_SETTINGS,
    mutate: (current) => ({
      ...current,
      agent: { ...current.agent, modelSelection: { model: 'gpt-4o', provider: 'openai' } },
    }),
    stripSensitiveSettings,
    disableLogging: true,
  });

  expect(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8')).agent.modelSelection).toEqual({
    model: 'gpt-4o',
    provider: 'openai',
  });
  expect(fs.existsSync(lockFile)).toBe(false);
  expect(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
});

it('acquireSettingsLock: a stale owner cannot release its successor lock', () => {
  const dir = makeTempDir();
  const lockFile = path.join(dir, 'settings.json.lock');
  const releaseStaleOwner = acquireSettingsLock(dir);
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, staleAt, staleAt);

  const releaseSuccessor = acquireSettingsLock(dir, { staleMs: 0, timeoutMs: 0 });
  releaseStaleOwner();

  expect(fs.existsSync(lockFile)).toBe(true);
  releaseSuccessor();
  expect(fs.existsSync(lockFile)).toBe(false);
});

it('saveSettingsToFile: removes its temp file when atomic rename fails', () => {
  const dir = makeTempDir();
  const rename = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
    throw new Error('rename failed');
  });

  try {
    const result = saveSettingsToFile({
      settingsDir: dir,
      schema: SettingsSchema,
      defaults: DEFAULT_SETTINGS,
      mutate: (current) => ({ ...current, agent: { ...current.agent, model: 'gpt-4o' } }),
      stripSensitiveSettings,
      disableLogging: true,
    });

    expect(result).toBe(undefined);
    expect(fs.readdirSync(dir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  } finally {
    rename.mockRestore();
  }
});

it('saveSettingsToFile: respects a fresh-mtime lock within its timeout budget without overwriting its settings file', () => {
  const dir = makeTempDir();
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
