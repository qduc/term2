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

  it('does not flag benign prose or URLs as high-entropy secrets', () => {
    expect(
      scanFixtureSecrets(
        'The fixture tool returned {ok: true, value: 1} which confirms the expected result of 1 exactly.',
      ).safe,
    ).toBe(true);
    expect(scanFixtureSecrets('https://api.example.com/v1/chat/completions?org=1234567890&k=abcdefghij').safe).toBe(
      true,
    );
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
