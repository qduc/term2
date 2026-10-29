import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { localLogDateKey, LoggingService } from './logging-service.js';
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

it('keeps a process alive after ENOSPC, reports once, and drops further logs without Winston noise', async () => {
  const directory = await temporaryDirectory();
  const secondDirectory = join(directory, 'second');
  const today = localLogDateKey();
  if (process.env.TZ === 'Pacific/Kiritimati') {
    expect(today).not.toBe(new Date().toISOString().slice(0, 10));
  }
  await mkdir(secondDirectory);
  await symlink('/dev/full', join(directory, `term2-${today}.log`));
  await symlink('/dev/full', join(secondDirectory, `term2-${today}.log`));
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `import { LoggingService } from './source/services/logging/logging-service.ts';
       const failureReported = new Promise(resolve => {
         const write = process.stderr.write.bind(process.stderr);
         let stderrBuffer = '';
         process.stderr.write = (chunk, ...args) => {
           const result = write(chunk, ...args);
           stderrBuffer += String(chunk);
           if (stderrBuffer.includes('File logging disabled after write failure')) resolve();
           return result;
         };
       });
       const logging = new LoggingService({ logDir: process.argv[1], suppressConsoleOutput: true });
       const second = new LoggingService({ logDir: process.argv[2], suppressConsoleOutput: true });
       for (let i = 0; i < 10; i++) { logging.info('write ' + i); second.info('write ' + i); }
       await failureReported;
       process.stdout.write('TURN_FINISHED\\n', () => process.exit(0));`,
      directory,
      secondDirectory,
    ],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain('TURN_FINISHED');
  expect(child.stderr.match(/File logging disabled after write failure/g)).toHaveLength(1);
  expect(child.stderr).not.toContain('[winston]');
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
  const currentOversizedDay = join(trafficDir, dateForDaysAgo(0), 'session-current-large');
  const oldApplicationLog = join(logDir, `term2-${dateForDaysAgo(30)}.log.1`);
  const oversizedApplicationLog = join(logDir, `term2-${dateForDaysAgo(3)}.log.1`);
  const recentApplicationLog = join(logDir, `term2-${localLogDateKey()}.log`);
  const currentOversizedApplicationLog = join(logDir, `term2-${localLogDateKey()}.log.1`);
  await Promise.all([
    mkdir(oldDay, { recursive: true }),
    mkdir(oversizedDay, { recursive: true }),
    mkdir(recentDay, { recursive: true }),
    mkdir(currentOversizedDay, { recursive: true }),
  ]);
  await writeFile(join(oldDay, 'request.json'), '{}');
  await writeFile(join(oversizedDay, 'request.json'), '');
  await truncate(join(oversizedDay, 'request.json'), 512 * 1024 * 1024 + 1);
  await writeFile(join(recentDay, 'request.json'), '{"sent":true}');
  await writeFile(join(currentOversizedDay, 'request.json'), '');
  await truncate(join(currentOversizedDay, 'request.json'), 512 * 1024 * 1024 + 1);
  await writeFile(oldApplicationLog, '{}');
  await writeFile(oversizedApplicationLog, '');
  await truncate(oversizedApplicationLog, 512 * 1024 * 1024 + 1);
  await writeFile(recentApplicationLog, '{}');
  await writeFile(currentOversizedApplicationLog, '');
  await truncate(currentOversizedApplicationLog, 512 * 1024 * 1024 + 1);

  new LoggingService({ logDir });

  expect(existsSync(join(trafficDir, dateForDaysAgo(30)))).toBe(false);
  expect(existsSync(join(trafficDir, dateForDaysAgo(3)))).toBe(false);
  expect(existsSync(join(recentDay, 'request.json'))).toBe(true);
  expect(existsSync(join(currentOversizedDay, 'request.json'))).toBe(true);
  expect(existsSync(oldApplicationLog)).toBe(false);
  expect(existsSync(oversizedApplicationLog)).toBe(false);
  expect(existsSync(recentApplicationLog)).toBe(true);
  expect(existsSync(currentOversizedApplicationLog)).toBe(true);
});

it('continues startup and logs one warning when retention cannot delete old traffic', async () => {
  const directory = await temporaryDirectory();
  const logDirs = [join(directory, 'logs-one'), join(directory, 'logs-two')];
  const trafficDirs = logDirs.map((logDir) => join(logDir, 'provider-traffic'));
  const oldDate = new Date();
  oldDate.setUTCDate(oldDate.getUTCDate() - 30);
  for (const trafficDir of trafficDirs) {
    const oldDay = join(trafficDir, oldDate.toISOString().slice(0, 10));
    await mkdir(oldDay, { recursive: true });
    await writeFile(join(oldDay, 'request.json'), '{}');
    await chmod(trafficDir, 0o555);
  }

  expect(() => logDirs.forEach((logDir) => new LoggingService({ logDir }))).not.toThrow();
  const readWarnings = async () => {
    const warnings: string[] = [];
    for (const logDir of logDirs) {
      const applicationLog = (await readdir(logDir)).find((name) => /^term2-\d{4}-\d{2}-\d{2}\.log$/.test(name));
      if (applicationLog) warnings.push(await readFile(join(logDir, applicationLog), 'utf8'));
    }
    return warnings.join('');
  };
  await expect.poll(readWarnings, { timeout: 5_000 }).toContain('logging.retention_cleanup_failed');
  await Promise.all(trafficDirs.map((trafficDir) => chmod(trafficDir, 0o700)));

  expect((await readWarnings()).match(/logging\.retention_cleanup_failed/g)).toHaveLength(1);
});

it('continues measuring sibling traffic entries when one subdirectory is unreadable', async () => {
  const directory = await temporaryDirectory();
  const trafficDir = join(directory, 'logs', 'provider-traffic');
  const unreadableDate = new Date();
  unreadableDate.setUTCDate(unreadableDate.getUTCDate() - 1);
  const largeDate = new Date();
  largeDate.setUTCDate(largeDate.getUTCDate() - 2);
  const unreadableDir = join(trafficDir, unreadableDate.toISOString().slice(0, 10), 'unreadable');
  const oversizedDir = join(trafficDir, largeDate.toISOString().slice(0, 10));
  await mkdir(unreadableDir, { recursive: true });
  await mkdir(oversizedDir, { recursive: true });
  await writeFile(join(oversizedDir, 'large.json'), '');
  await truncate(join(oversizedDir, 'large.json'), 512 * 1024 * 1024 + 1);
  await chmod(unreadableDir, 0o000);

  try {
    expect(() => new LoggingService({ logDir: join(directory, 'logs') })).not.toThrow();
    expect(existsSync(oversizedDir)).toBe(false);
  } finally {
    await chmod(unreadableDir, 0o700);
  }
});
