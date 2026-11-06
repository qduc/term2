import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createTestChildEnv, testCliPath } from '../tests/helpers/terminal-e2e.js';

const cli = testCliPath(fileURLToPath(new URL('../dist/cli.js', import.meta.url)));
const refusal = 'error The legacy conversations directory is read-only; use a separate native conversations directory';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'term2-native-legacy-store-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  mkdirSync(cwd);
  const data =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'term2-nodejs')
      : path.join(root, 'data', 'term2-nodejs');
  mkdirSync(data, { recursive: true });
  const legacy = path.join(data, 'conversations');
  const env = createTestChildEnv({
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_CONFIG_HOME: path.join(root, 'config'),
    XDG_STATE_HOME: path.join(root, 'state'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
  });
  const run = (directory?: string, args = ['--resume', 'ls']) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd,
      env: { ...env, ...(directory === undefined ? {} : { TERM2_CONVERSATIONS_DIR: directory }) },
      encoding: 'utf8',
      timeout: 10_000,
    });
  return { root, cwd, data, legacy, run };
}

it.skipIf(process.platform === 'win32').each(['missing', 'empty', 'populated'] as const)(
  'refuses the %s legacy store and its aliases without creating or modifying it',
  (state) => {
    const { root, cwd, data, legacy, run } = fixture();
    try {
      if (state !== 'missing') mkdirSync(legacy);
      if (state === 'populated') writeFileSync(path.join(legacy, 'legacy.jsonl'), 'legacy sentinel\n');
      const leafAlias = path.join(root, 'legacy-alias');
      const parentAlias = path.join(root, 'data-alias');
      const childAlias = path.join(root, 'child-alias');
      const relativeAlias = path.join(root, 'relative-alias');
      mkdirSync(path.join(data, 'child'));
      symlinkSync(legacy, leafAlias, 'dir');
      symlinkSync(data, parentAlias, 'dir');
      symlinkSync(path.join(data, 'child'), childAlias, 'dir');
      symlinkSync('child-alias/../conversations', relativeAlias, 'dir');
      const before = state === 'missing' ? [] : readdirSync(legacy);
      for (const directory of [
        legacy,
        path.relative(cwd, legacy),
        leafAlias,
        `${leafAlias}/`,
        path.join(parentAlias, 'conversations'),
        `${childAlias}/../conversations`,
        relativeAlias,
      ]) {
        const result = run(directory);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr.trim()).toBe(refusal);
        expect(existsSync(legacy)).toBe(state !== 'missing');
        if (state !== 'missing') expect(readdirSync(legacy)).toEqual(before);
        if (state === 'populated')
          expect(readFileSync(path.join(legacy, 'legacy.jsonl'), 'utf8')).toBe('legacy sentinel\n');
      }
      if (process.platform === 'darwin') {
        const result = run(path.join(data, 'CONVERSATIONS'));
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr.trim()).toBe(refusal);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'refuses a headless launch into a missing legacy store through an alias',
  () => {
    const { root, legacy, run } = fixture();
    try {
      const alias = path.join(root, 'legacy-alias');
      symlinkSync(legacy, alias, 'dir');
      // The nonexistent provider prevents inference even if the store guard regresses.
      const result = run(alias, ['--lite', '--provider', 'legacy-store-fixture', '--model', 'unused', 'probe']);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr.trim()).toBe(refusal);
      expect(existsSync(legacy)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'uses the checked directory when lexical normalization would point at the legacy store',
  () => {
    const { root, data, legacy, run } = fixture();
    try {
      mkdirSync(legacy);
      writeFileSync(path.join(legacy, 'legacy.jsonl'), 'legacy sentinel\n');
      const outside = path.join(root, 'outside');
      mkdirSync(path.join(outside, 'child'), { recursive: true });
      mkdirSync(path.join(outside, 'conversations'));
      const bridge = path.join(data, 'bridge');
      symlinkSync(path.join(outside, 'child'), bridge, 'dir');
      const result = run(`${bridge}/../conversations`);
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(path.join(legacy, 'legacy.jsonl'), 'utf8')).toBe('legacy sentinel\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'allows the native default and a distinct custom store named conversations',
  () => {
    const { root, run } = fixture();
    try {
      const custom = path.join(root, 'custom', 'conversations');
      mkdirSync(custom, { recursive: true });
      const alias = path.join(root, 'custom-alias');
      symlinkSync(custom, alias, 'dir');
      for (const directory of [undefined, custom, alias]) {
        const result = run(directory);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stdout + result.stderr).toBe(0);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
