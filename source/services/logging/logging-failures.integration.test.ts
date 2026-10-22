import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { LoggingService } from './logging-service.js';
import { ProviderTraffic, ProviderTrafficArtifactStore } from './provider-traffic.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'term2-logging-failure-'));
  directories.push(directory);
  return directory;
}

it('keeps a process alive after its daily log stream becomes unwritable and reports once', async () => {
  const directory = await temporaryDirectory();
  await chmod(directory, 0o555);
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { LoggingService } from './source/services/logging/logging-service.ts';
       const logging = new LoggingService({ logDir: process.argv[1], suppressConsoleOutput: true });
       for (let i = 0; i < 10; i++) logging.info('write ' + i);
       setTimeout(() => { console.log('TURN_FINISHED'); setTimeout(() => process.exit(0), 50); }, 150);`,
      directory,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
  );
  await chmod(directory, 0o700);

  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('TURN_FINISHED');
  expect(child.stderr.match(/File logging disabled after write failure/g)).toHaveLength(1);
  expect(child.stderr).not.toContain("Unhandled 'error' event");
});

it('surfaces provider traffic artifact failure once and leaves provider calls unblocked', async () => {
  const directory = await temporaryDirectory();
  const root = join(directory, 'read-only');
  await mkdir(root);
  await chmod(root, 0o555);
  const warn = vi.fn();
  const logging = {
    debug: vi.fn(),
    warn,
    error: vi.fn(),
    getCorrelationId: () => undefined,
  };
  const traffic = new ProviderTraffic(
    logging,
    { getContext: () => null } as never,
    new ProviderTrafficArtifactStore({ rootDir: root }),
  );

  expect(() =>
    traffic.recordRequestStart({ requestId: 'one', provider: 'fixture', model: 'fixture', sentBody: {} }),
  ).not.toThrow();
  expect(() =>
    traffic.recordRequestStart({ requestId: 'two', provider: 'fixture', model: 'fixture', sentBody: {} }),
  ).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(1);
  await chmod(root, 0o700);
});

it('removes aged and over-budget traffic days while preserving recent traffic', async () => {
  const directory = await temporaryDirectory();
  const logDir = join(directory, 'logs');
  const trafficDir = join(logDir, 'provider-traffic');
  const dateForDaysAgo = (days: number): string => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const oldDay = join(trafficDir, dateForDaysAgo(30), 'session-old');
  const oversizedDay = join(trafficDir, dateForDaysAgo(3), 'session-large');
  const recentDay = join(trafficDir, dateForDaysAgo(0), 'session-recent');
  const oldApplicationLog = join(logDir, `term2-${dateForDaysAgo(30)}.log.1`);
  const oversizedApplicationLog = join(logDir, `term2-${dateForDaysAgo(3)}.log.1`);
  const recentApplicationLog = join(logDir, `term2-${dateForDaysAgo(0)}.log`);
  await Promise.all([
    mkdir(oldDay, { recursive: true }),
    mkdir(oversizedDay, { recursive: true }),
    mkdir(recentDay, { recursive: true }),
  ]);
  await writeFile(join(oldDay, 'request.json'), '{}');
  await writeFile(join(oversizedDay, 'request.json'), '');
  await truncate(join(oversizedDay, 'request.json'), 512 * 1024 * 1024 + 1);
  await writeFile(join(recentDay, 'request.json'), '{"sent":true}');
  await writeFile(oldApplicationLog, '{}');
  await writeFile(oversizedApplicationLog, '');
  await truncate(oversizedApplicationLog, 512 * 1024 * 1024 + 1);
  await writeFile(recentApplicationLog, '{}');

  new LoggingService({ logDir });

  expect(existsSync(join(trafficDir, dateForDaysAgo(30)))).toBe(false);
  expect(existsSync(join(trafficDir, dateForDaysAgo(3)))).toBe(false);
  expect(existsSync(join(recentDay, 'request.json'))).toBe(true);
  expect(existsSync(oldApplicationLog)).toBe(false);
  expect(existsSync(oversizedApplicationLog)).toBe(false);
  expect(existsSync(recentApplicationLog)).toBe(true);
});

it('continues startup and logs one warning when retention cannot delete old traffic', async () => {
  const directory = await temporaryDirectory();
  const logDir = join(directory, 'logs');
  const trafficDir = join(logDir, 'provider-traffic');
  const oldDate = new Date();
  oldDate.setUTCDate(oldDate.getUTCDate() - 30);
  const oldDay = join(trafficDir, oldDate.toISOString().slice(0, 10));
  await mkdir(oldDay, { recursive: true });
  await writeFile(join(oldDay, 'request.json'), '{}');
  await chmod(trafficDir, 0o555);

  expect(() => new LoggingService({ logDir })).not.toThrow();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await chmod(trafficDir, 0o700);

  const applicationLog = (await readdir(logDir)).find((name) => /^term2-\d{4}-\d{2}-\d{2}\.log$/.test(name));
  expect(applicationLog).toBeTruthy();
  const contents = await readFile(join(logDir, applicationLog!), 'utf8');
  expect(contents.match(/logging\.retention_cleanup_failed/g)).toHaveLength(1);
});
