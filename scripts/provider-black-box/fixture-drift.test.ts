import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

describe('fixture transport SDK drift', () => {
  it('fails loudly when a fixture major/minor differs from the installed SDK', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { dependencies?: Record<string, string> };
    for (const file of await fixtureFiles('scripts/provider-black-box/fixtures')) {
      const fixture = JSON.parse(await readFile(file, 'utf8')) as {
        capture: { sdkPackage: string; apiSdkVersion: string };
      };
      const declared = packageJson.dependencies?.[fixture.capture.sdkPackage];
      if (!declared || fixture.capture.sdkPackage === 'fixture-fake-provider') continue;
      const installed = JSON.parse(
        await readFile(join('node_modules', fixture.capture.sdkPackage, 'package.json'), 'utf8'),
      ) as { version: string };
      const expected = majorMinor(fixture.capture.apiSdkVersion);
      const actual = majorMinor(installed.version);
      expect(
        actual,
        `${file}: recapture fixture for ${fixture.capture.sdkPackage}; recorded ${fixture.capture.apiSdkVersion}, installed ${installed.version}`,
      ).toBe(expected);
    }
  });
});

async function fixtureFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) result.push(...(await fixtureFiles(path)));
    else if (item.name.endsWith('.json')) result.push(path);
  }
  return result;
}
function majorMinor(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)/);
  if (!match) throw new Error(`Invalid SDK version ${version}`);
  return `${match[1]}.${match[2]}`;
}
