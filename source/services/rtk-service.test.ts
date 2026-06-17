import { it, expect } from 'vitest';
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

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-rtk-test-'));

  // TODO: // TODO: t.teardown(() => fs.rmSync(dir, { recursive: true, force: true })) needs manual try/finally conversion;
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

it('RTK_VERSION and RTK_REPO are set', () => {
  expect(typeof RTK_VERSION).toBe('string');
  expect(RTK_VERSION.startsWith('v')).toBe(true);
  expect(RTK_REPO).toBe('rtk-ai/rtk');
});

// ── resolveRtkAsset ──────────────────────────────────────────────────────────

it('resolveRtkAsset maps linux x64 correctly', () => {
  expect(resolveRtkAsset('linux', 'x64')).toBe('rtk-x86_64-unknown-linux-musl.tar.gz');
});

it('RTK_ASSET_CHECKSUMS includes checksum for every supported asset', () => {
  const supportedAssets = [
    resolveRtkAsset('linux', 'x64'),
    resolveRtkAsset('linux', 'arm64'),
    resolveRtkAsset('darwin', 'x64'),
    resolveRtkAsset('darwin', 'arm64'),
  ];

  for (const asset of supportedAssets) {
    expect(asset).toBeTruthy();
    expect(RTK_ASSET_CHECKSUMS[asset!]).toMatch(/^[0-9a-f]{64}$/);
  }
});

it('resolveRtkAsset maps linux arm64 correctly', () => {
  expect(resolveRtkAsset('linux', 'arm64')).toBe('rtk-aarch64-unknown-linux-gnu.tar.gz');
});

it('resolveRtkAsset maps darwin x64 correctly', () => {
  expect(resolveRtkAsset('darwin', 'x64')).toBe('rtk-x86_64-apple-darwin.tar.gz');
});

it('resolveRtkAsset maps darwin arm64 correctly', () => {
  expect(resolveRtkAsset('darwin', 'arm64')).toBe('rtk-aarch64-apple-darwin.tar.gz');
});

it('resolveRtkAsset returns null for win32', () => {
  expect(resolveRtkAsset('win32', 'x64')).toBe(null);
});

it('resolveRtkAsset returns null for unknown arch', () => {
  expect(resolveRtkAsset('linux', 'mips')).toBe(null);
});

it('resolveRtkAsset returns null for unknown platform', () => {
  expect(resolveRtkAsset('freebsd' as any, 'x64')).toBe(null);
});

// ── getRtkBinaryPath ─────────────────────────────────────────────────────────

it('getRtkBinaryPath includes version and rtk binary name', () => {
  const p = getRtkBinaryPath({ cacheDir: '/fake/cache' });
  expect(p.includes(RTK_VERSION)).toBe(true);
  expect(p.endsWith('rtk')).toBe(true);
  expect(p.startsWith('/fake/cache')).toBe(true);
});

// ── isRtkSupportedCommand ────────────────────────────────────────────────────

const ALLOWLISTED = ['git', 'npm', 'pnpm', 'yarn', 'cargo', 'pytest', 'go', 'rg', 'grep', 'cat', 'ls'];

for (const cmd of ALLOWLISTED) {
  it(`isRtkSupportedCommand: '${cmd}' alone is supported`, () => {
    expect(isRtkSupportedCommand(cmd)).toBe(true);
  });

  it(`isRtkSupportedCommand: '${cmd} with args' is supported`, () => {
    expect(isRtkSupportedCommand(`${cmd} status --short`)).toBe(true);
  });
}

it('isRtkSupportedCommand: non-allowlisted command is rejected', () => {
  expect(isRtkSupportedCommand('curl https://example.com')).toBe(false);
  expect(isRtkSupportedCommand('printf hello')).toBe(false);
});

it('isRtkSupportedCommand: supported when at least one top-level command is eligible', () => {
  expect(isRtkSupportedCommand('git status && git log')).toBe(true);
  expect(isRtkSupportedCommand('npm test || cat error.log')).toBe(true);
  expect(isRtkSupportedCommand('git status; git log')).toBe(true);
  expect(isRtkSupportedCommand('git log $(date)')).toBe(true);
});

it('isRtkSupportedCommand: supported when a chain mixes eligible and ineligible commands', () => {
  expect(isRtkSupportedCommand('curl https://x && git log')).toBe(true);
  expect(isRtkSupportedCommand('npm run dev & npm test')).toBe(true);
});

it('isRtkSupportedCommand: rejected when no top-level command is eligible', () => {
  expect(isRtkSupportedCommand('curl https://example.com')).toBe(false);
  expect(isRtkSupportedCommand('git status > out.txt')).toBe(false);
  expect(isRtkSupportedCommand('git log 2>&1')).toBe(false);
  expect(isRtkSupportedCommand('grep pattern < file.txt')).toBe(false);
  expect(isRtkSupportedCommand('npm install &')).toBe(false);
});

it('isRtkSupportedCommand: does not descend into subshells', () => {
  expect(isRtkSupportedCommand('(cd src && git log)')).toBe(false);
});

it('isRtkSupportedCommand: empty command is rejected', () => {
  expect(isRtkSupportedCommand('')).toBe(false);
  expect(isRtkSupportedCommand('   ')).toBe(false);
});

it('isRtkSupportedCommand: malformed command does not throw and is rejected', () => {
  expect(() => isRtkSupportedCommand('git log ('));
  expect(isRtkSupportedCommand('git log (')).toBe(false);
});

// ── wrapWithRtk ───────────────────────────────────────────────────────────────

it('wrapWithRtk prefixes a single command with quoted rtkPath', () => {
  expect(wrapWithRtk('git status', '/path/to/rtk')).toBe('"/path/to/rtk" git status');
});

it('wrapWithRtk handles path with spaces via quoting', () => {
  expect(wrapWithRtk('ls -la', '/path with spaces/rtk')).toBe('"/path with spaces/rtk" ls -la');
});

it('wrapWithRtk wraps every eligible command in a logical/sequence chain', () => {
  expect(wrapWithRtk('npm run build && npm test', '/r')).toBe('"/r" npm run build && "/r" npm test');
  expect(wrapWithRtk('git status; git log', '/r')).toBe('"/r" git status; "/r" git log');
});

it('wrapWithRtk never wraps any command in a pipeline', () => {
  // The producer's stdout is the next command's stdin; altering it would
  // change the consumer's input. The whole pipeline is left untouched.
  expect(wrapWithRtk('git log | grep foo', '/r')).toBe('git log | grep foo');
  expect(wrapWithRtk('git log | grep x | head', '/r')).toBe('git log | grep x | head');
  expect(wrapWithRtk('git log | tee out.txt', '/r')).toBe('git log | tee out.txt');
  expect(wrapWithRtk('git log | grep x > out.txt', '/r')).toBe('git log | grep x > out.txt');
});

it('wrapWithRtk wraps eligible commands around a pipeline but not within it', () => {
  expect(wrapWithRtk('git status && git log | grep x', '/r')).toBe('"/r" git status && git log | grep x');
});

it('isRtkSupportedCommand rejects standalone pipelines', () => {
  expect(isRtkSupportedCommand('git log | grep foo')).toBe(false);
  expect(isRtkSupportedCommand('git log | tee out.txt')).toBe(false);
  expect(isRtkSupportedCommand('git log | grep x > out.txt')).toBe(false);
});

it('wrapWithRtk leaves ineligible commands in a chain untouched', () => {
  expect(wrapWithRtk('curl https://x && git log', '/r')).toBe('curl https://x && "/r" git log');
  expect(wrapWithRtk('npm run dev & npm test', '/r')).toBe('npm run dev & "/r" npm test');
  // A redirect on one branch must not block wrapping a sibling branch.
  expect(wrapWithRtk('git diff > f && git log', '/r')).toBe('git diff > f && "/r" git log');
});

it('wrapWithRtk does not descend into command substitution or subshells', () => {
  expect(wrapWithRtk('git log $(date)', '/r')).toBe('"/r" git log $(date)');
  expect(wrapWithRtk('(cd src && git log)', '/r')).toBe('(cd src && git log)');
});

it('wrapWithRtk returns the command unchanged when nothing is eligible', () => {
  expect(wrapWithRtk('git status > out.txt', '/r')).toBe('git status > out.txt');
  expect(wrapWithRtk('git log (', '/r')).toBe('git log (');
});

// ── ensureRtkInstalled ────────────────────────────────────────────────────────

it.sequential('ensureRtkInstalled returns path when binary already exists', async () => {
  const cacheDir = makeTmpDir();
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

  expect(result).toBe(binaryPath);
  expect(fetchCalled, 'fetch should not be called when binary exists').toBe(false);
});

it.sequential('ensureRtkInstalled returns null for unsupported platform', async () => {
  const cacheDir = makeTmpDir();
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'win32',
    arch: 'x64',
  });

  expect(result).toBe(null);
  expect(warnMessages.some((m) => m.includes('rtk'))).toBe(true);
});

it.sequential('ensureRtkInstalled returns null when fetch fails with non-ok response', async () => {
  const cacheDir = makeTmpDir();
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response('Not Found', { status: 404 }),
  });

  expect(result).toBe(null);
  expect(warnMessages.some((m) => m.includes('rtk'))).toBe(true);
});

it.sequential('ensureRtkInstalled returns null when fetch throws', async () => {
  const cacheDir = makeTmpDir();
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

  expect(result).toBe(null);
  expect(warnMessages.some((m) => m.includes('rtk'))).toBe(true);
});

it.sequential('ensureRtkInstalled returns null when extraction fails', async () => {
  const cacheDir = makeTmpDir();
  const warnMessages: string[] = [];

  const result = await ensureRtkInstalled({
    loggingService: { ...noopLogger(), warn: (msg: string) => warnMessages.push(msg) },
    cacheDir,
    platform: 'linux',
    arch: 'x64',
    fetchImpl: async () => new Response(new Uint8Array([0x1f, 0x8b]).buffer, { status: 200 }),
    extractImpl: () => ({ status: 1 }),
  });

  expect(result).toBe(null);
  expect(warnMessages.some((m) => m.includes('rtk'))).toBe(true);
});

it.sequential('ensureRtkInstalled returns null and does not install when checksum does not match', async () => {
  const cacheDir = makeTmpDir();
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
      throw new Error('extract should not run when checksum verification fails');
      return { status: 0 };
    },
  });

  expect(result).toBe(null);
  expect(fs.existsSync(getRtkBinaryPath({ cacheDir }))).toBe(false);
  expect(warnMessages.some((m) => m.includes('checksum'))).toBe(true);
});

it.sequential('ensureRtkInstalled returns binary path on successful install', async () => {
  const cacheDir = makeTmpDir();
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

  expect(result).toBeTruthy();
  expect(result!.endsWith('rtk')).toBe(true);
  expect(fs.existsSync(result!)).toBe(true);
});
