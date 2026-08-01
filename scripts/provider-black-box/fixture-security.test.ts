import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { scanFixtureSecrets } from './fixture-sanitizer.js';

describe('committed fixture security', () => {
  it('rejects common secret forms', () => {
    for (const value of [
      'Bearer abcdefghijklmnop',
      'sk-proj-abcdefghijklmnopqrstuvwxyz',
      '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      'aVeryLongSecretValue_1234567890!abcdefghijklmnopqrstuvwxyz',
    ])
      expect(scanFixtureSecrets(value).safe).toBe(false);
  });

  it('contains no likely secrets in committed fixture JSON', async () => {
    const root = join(process.cwd(), 'scripts/provider-black-box/fixtures');
    for (const file of await jsonFiles(root)) {
      const result = scanFixtureSecrets(JSON.parse(await readFile(file, 'utf8')));
      expect(result.findings, file).toEqual([]);
    }
  });
});

async function jsonFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await jsonFiles(path)));
    else if (entry.name.endsWith('.json')) result.push(path);
  }
  return result;
}
