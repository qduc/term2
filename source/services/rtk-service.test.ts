import test from 'ava';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import {
  RTK_VERSION,
  RTK_REPO,
  RTK_ASSET_CHECKSUMS,
  resolveRtkAsset,
  getRtkBinaryPath,
  isRtkSupportedCommand,
  wrapWithRtk,
  ensureRtkInstalled,
} from './rtk-service.js';
import type { ILoggingService } from './service-interfaces.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(t: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-rtk-test-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function noopLogger(): ILoggingService {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    setCorrelationId: () => {},
    getCorrelationId: () => undefined,
    clearCorrelationId: () => {},
  };
}

// ── constants ─────────────────────────────────────────────────────────────────

test('RTK_VERSION and RTK_REPO are set', (t) => {
  t.is(typeof RTK_VERSION, 'string');
  t.true(RTK_VERSION.startsWith('v'));
  t.is(RTK_REPO, 'rtk-ai/rtk');
});

// ── resolveRtkAsset ──────────────────────────────────────────────────────────

test('resolveRtkAsset maps linux x64 correctly', (t) => {
  t.is(resolveRtkAsset('linux', 'x64'), 'rtk-x86_64-unknown-linux-musl.tar.gz');
});

test('RTK_ASSET_CHECKSUMS includes checksum for every supported asset', (t) => {
  const supportedAssets = [
    resolveRtkAsset('linux', 'x64'),
    resolveRtkAsset('linux', 'arm64'),
    resolveRtkAsset('darwin', 'x64'),
    resolveRtkAsset('darwin', 'arm64'),
  ];

  for (const asset of supportedAssets) {
    t.truthy(asset);
    t.regex(RTK_ASSET_CHECKSUMS[asset!], /^[0-9a-f]{64}$/);
  }
});

test('resolveRtkAsset maps linux arm64 correctly', (t) => {
  t.is(resolveRtkAsset('linux', 'arm64'), 'rtk-aarch64-unknown-linux-gnu.tar.gz');
});

test('resolveRtkAsset maps darwin x64 correctly', (t) => {
  t.is(resolveRtkAsset('darwin', 'x64'), 'rtk-x86_64-apple-darwin.tar.gz');
});

test('resolveRtkAsset maps darwin arm64 correctly', (t) => {
  t.is(resolveRtkAsset('darwin', 'arm64'), 'rtk-aarch64-apple-darwin.tar.gz');
});

test('resolveRtkAsset returns null for win32', (t) => {
  t.is(resolveRtkAsset('win32', 'x64'), null);
});

test('resolveRtkAsset returns null for unknown arch', (t) => {
  t.is(resolveRtkAsset('linux', 'mips'), null);
});

test('resolveRtkAsset returns null for unknown platform', (t) => {
  t.is(resolveRtkAsset('freebsd' as any, 'x64'), null);
});

// ── getRtkBinaryPath ─────────────────────────────────────────────────────────

test('getRtkBinaryPath includes version and rtk binary name', (t) => {
  const p = getRtkBinaryPath({ cacheDir: '/fake/cache' });
  t.true(p.includes(RTK_VERSION), 'path should include version');
  t.true(p.endsWith('rtk'), 'path should end with rtk');
  t.true(p.startsWith('/fake/cache'), 'path should start with cacheDir');
});

// ── isRtkSupportedCommand ────────────────────────────────────────────────────

const ALLOWLISTED = ['git', 'npm', 'pnpm', 'yarn', 'cargo', 'pytest', 'go', 'rg', 'grep', 'cat', 'ls'];

for (const cmd of ALLOWLISTED) {
  test(`isRtkSupportedCommand: '${cmd}' alone is supported`, (t) => {
    t.true(isRtkSupportedCommand(cmd));
  });

  test(`isRtkSupportedCommand: '${cmd} with args' is supported`, (t) => {
    t.true(isRtkSupportedCommand(`${cmd} status --short`));
  });
}

test('isRtkSupportedCommand: non-allowlisted command is rejected', (t) => {
  t.false(isRtkSupportedCommand('curl https://example.com'));
  t.false(isRtkSupportedCommand('printf hello'));
});

test('isRtkSupportedCommand: supported when at least one top-level command is eligible', (t) => {
  t.true(isRtkSupportedCommand('git status && git log'));
  t.true(isRtkSupportedCommand('npm test || cat error.log'));
  t.true(isRtkSupportedCommand('git status; git log'));
  t.true(isRtkSupportedCommand('git log $(date)'));
});

test('isRtkSupportedCommand: supported when a chain mixes eligible and ineligible commands', (t) => {
  t.true(isRtkSupportedCommand('curl https://x && git log'));
  t.true(isRtkSupportedCommand('npm run dev & npm test'));
});

test('isRtkSupportedCommand: rejected when no top-level command is eligible', (t) => {
  t.false(isRtkSupportedCommand('curl https://example.com'));
  t.false(isRtkSupportedCommand('git status > out.txt'));
  t.false(isRtkSupportedCommand('git log 2>&1'));
  t.false(isRtkSupportedCommand('grep pattern < file.txt'));
  t.false(isRtkSupportedCommand('npm install &'));
});

test('isRtkSupportedCommand: does not descend into subshells', (t) => {
  t.false(isRtkSupportedCommand('(cd src && git log)'));
});

test('isRtkSupportedCommand: empty command is rejected', (t) => {
  t.false(isRtkSupportedCommand(''));
  t.false(isRtkSupportedCommand('   '));
});

test('isRtkSupportedCommand: malformed command does not throw and is rejected', (t) => {
  t.notThrows(() => isRtkSupportedCommand('git log ('));
  t.false(isRtkSupportedCommand('git log ('));
});

// ── wrapWithRtk ───────────────────────────────────────────────────────────────

test('wrapWithRtk prefixes a single command with quoted rtkPath', (t) => {
  t.is(wrapWithRtk('git status', '/path/to/rtk'), '"/path/to/rtk" git status');
});

test('wrapWithRtk handles path with spaces via quoting', (t) => {
  t.is(wrapWithRtk('ls -la', '/path with spaces/rtk'), '"/path with spaces/rtk" ls -la');
});

test('wrapWithRtk wraps every eligible command in a logical/sequence chain', (t) => {
  t.is(wrapWithRtk('npm run build && npm test', '/r'), '"/r" npm run build && "/r" npm test');
  t.is(wrapWithRtk('git status; git log', '/r'), '"/r" git status; "/r" git log');
});

test('wrapWithRtk never wraps any command in a pipeline', (t) => {
  // The producer's stdout is the next command's stdin; altering it would
  // change the consumer's input. The whole pipeline is left untouched.
  t.is(wrapWithRtk('git log | grep foo', '/r'), 'git log | grep foo');
  t.is(wrapWithRtk('git log | grep x | head', '/r'), 'git log | grep x | head');
  t.is(wrapWithRtk('git log | tee out.txt', '/r'), 'git log | tee out.txt');
  t.is(wrapWithRtk('git log | grep x > out.txt', '/r'), 'git log | grep x > out.txt');
});

test('wrapWithRtk wraps eligible commands around a pipeline but not within it', (t) => {
  t.is(wrapWithRtk('git status && git log | grep x', '/r'), '"/r" git status && git log | grep x');
});

test('isRtkSupportedCommand rejects standalone pipelines', (t) => {
  t.false(isRtkSupportedCommand('git log | grep foo'));
  t.false(isRtkSupportedCommand('git log | tee out.txt'));
  t.false(isRtkSupportedCommand('git log | grep x > out.txt'));
});

test('wrapWithRtk leaves ineligible commands in a chain untouched', (t) => {
  t.is(wrapWithRtk('curl https://x && git log', '/r'), 'curl https://x && "/r" git log');
  t.is(wrapWithRtk('npm run dev & npm test', '/r'), 'npm run dev & "/r" npm test');
  // A redirect on one branch must not block wrapping a sibling branch.
  t.is(wrapWithRtk('git diff > f && git log', '/r'), 'git diff > f && "/r" git log');
});

test('wrapWithRtk does not descend into command substitution or subshells', (t) => {
  t.is(wrapWithRtk('git log $(date)', '/r'), '"/r" git log $(date)');
  t.is(wrapWithRtk('(cd src && git log)', '/r'), '(cd src && git log)');
});

test('wrapWithRtk returns the command unchanged when nothing is eligible', (t) => {
  t.is(wrapWithRtk('git status > out.txt', '/r'), 'git status > out.txt');
  t.is(wrapWithRtk('git log (', '/r'), 'git log (');
});

// ── ensureRtkInstalled ────────────────────────────────────────────────────────

test.serial('ensureRtkInstalled returns path when binary already exists', async (t) => {
  const cacheDir = makeTmpDir(t);
  const binaryPath = getRtkBinaryPath({ cacheDir });
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, 'fake-binary');
  fs.chmodSync(binaryPath, 0o755);

  let fetchCalled = false;
  const result = await ensureRtkInstalled({
    loggingService: noopLogger(),
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    },
  });

  t.is(result, binaryPath);
  t.false(fetchCalled, 'fetch should not be called when binary exists');
});

test.serial('ensureRtkInstalled returns null for unsupported platform', async (t) => {
  const cacheDir = makeTmpDir(t);
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'win32',
    arch: 'x64',
  });

  t.is(result, null);
  t.true(warnMessages.some((m) => m.includes('rtk')));
});

test.serial('ensureRtkInstalled returns null when fetch fails with non-ok response', async (t) => {
  const cacheDir = makeTmpDir(t);
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response('Not Found', { status: 404 }),
  });

  t.is(result, null);
  t.true(warnMessages.some((m) => m.includes('rtk')));
});

test.serial('ensureRtkInstalled returns null when fetch throws', async (t) => {
  const cacheDir = makeTmpDir(t);
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => {
      throw new Error('network error');
    },
  });

  t.is(result, null);
  t.true(warnMessages.some((m) => m.includes('rtk')));
});

test.serial('ensureRtkInstalled returns null when extraction fails', async (t) => {
  const cacheDir = makeTmpDir(t);
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(new Uint8Array([0x1f, 0x8b]).buffer, { status: 200 }),
    extractImpl: () => ({ status: 1 }),
  });

  t.is(result, null);
  t.true(warnMessages.some((m) => m.includes('rtk')));
});

test.serial('ensureRtkInstalled returns null and does not install when checksum does not match', async (t) => {
  const cacheDir = makeTmpDir(t);
  const warnMessages: string[] = [];
  const fakeBytes = Buffer.from('fake tarball content');

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(fakeBytes, { status: 200 }),
    assetChecksums: {
      'rtk-x86_64-unknown-linux-musl.tar.gz': '0'.repeat(64),
    },
    extractImpl: () => {
      t.fail('extract should not run when checksum verification fails');
      return { status: 0 };
    },
  });

  t.is(result, null);
  t.false(fs.existsSync(getRtkBinaryPath({ cacheDir })));
  t.true(warnMessages.some((m) => m.includes('checksum')));
});

test.serial('ensureRtkInstalled returns binary path on successful install', async (t) => {
  const cacheDir = makeTmpDir(t);
  const fakeBytes = Buffer.from('fake tarball content');
  const checksum = createHash('sha256').update(fakeBytes).digest('hex');

  const result = await ensureRtkInstalled({
    loggingService: noopLogger(),
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(fakeBytes, { status: 200 }),
    assetChecksums: {
      'rtk-x86_64-unknown-linux-musl.tar.gz': checksum,
    },
    extractImpl: (_tarPath: string, destDir: string) => {
      fs.writeFileSync(path.join(destDir, 'rtk'), '#!/bin/sh\necho rtk');
      return { status: 0 };
    },
  });

  t.truthy(result);
  t.true(result!.endsWith('rtk'));
  t.true(fs.existsSync(result!));
});
