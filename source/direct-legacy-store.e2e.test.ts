import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { testCliPath } from './test-helpers/terminal-e2e.js';

const cli = testCliPath(fileURLToPath(new URL('../rewrite/dist/rewrite/src/app/cli.js', import.meta.url)));

it('refuses a legacy store override without changing it, including a symlink alias', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-legacy-store-'));
  try {
    const legacy = path.join(root, 'data', 'term2-nodejs', 'conversations');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'legacy.jsonl'), 'legacy sentinel\n');
    const alias = path.join(root, 'alias');
    fs.symlinkSync(legacy, alias, 'dir');
    const before = fs.readdirSync(legacy).map((name) => [name, fs.readFileSync(path.join(legacy, name), 'utf8')]);
    for (const directory of [legacy, alias]) {
      const result = spawnSync(process.execPath, [cli, '--resume', 'ls'], {
        cwd: root,
        env: { ...process.env, HOME: root, XDG_DATA_HOME: path.join(root, 'data'), TERM2_CONVERSATIONS_DIR: directory },
        encoding: 'utf8',
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr.trim()).toBe(
        'error The legacy conversations directory is read-only for this version; migration comes later',
      );
      expect(fs.readdirSync(legacy).map((name) => [name, fs.readFileSync(path.join(legacy, name), 'utf8')])).toEqual(
        before,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
