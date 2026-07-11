/**
 * Security regression tests for agent-runtime scope enforcement.
 *
 * Covers path traversal, glob boundary cases, host suffix confusion,
 * port normalization, scope intersection, symlink escape defense,
 * and edge cases that must never regress.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  normalizeToolPath,
  resolveRealToolPath,
  isPathInScopeSafe,
  normalizeScopePattern,
  normalizeHostPattern,
  isPathInScope,
  isHostInScope,
  resolveFilesystemScopes,
  resolveNetworkScopes,
  setWorkspaceRoot,
} from './scope-resolver.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { symlink, rm } from 'node:fs/promises';

const TEST_ROOT = path.resolve(os.tmpdir(), 'term2-sec-test-' + process.pid);

beforeEach(() => {
  setWorkspaceRoot(TEST_ROOT);
});

// ── Path traversal ────────────────────────────────────────────────

describe('path traversal defense', () => {
  it('rejects ../ that escapes workspace root', () => {
    expect(normalizeToolPath('../etc/passwd')).toBeNull();
  });

  it('rejects deeply nested traversal escape', () => {
    expect(normalizeToolPath('src/../../../etc/passwd')).toBeNull();
  });

  it('rejects absolute path outside workspace', () => {
    expect(normalizeToolPath('/etc/passwd')).toBeNull();
  });

  it('rejects null byte injection', () => {
    expect(normalizeToolPath('src/\x00evil')).toBeNull();
  });

  it('rejects traversal even when root is "/" (edge case)', () => {
    // If workspace root were "/", traversal to /etc would still be outside
    // because resolved path must start with root + sep
    expect(normalizeToolPath('../../etc/passwd')).toBeNull();
  });

  it('allows .. that stays within workspace', () => {
    expect(normalizeToolPath('src/../src/file.ts')).toBe(path.resolve(TEST_ROOT, 'src/file.ts'));
  });

  it('rejects scope pattern with traversal', () => {
    expect(normalizeScopePattern('../src/**')).toBeNull();
  });

  it('rejects scope pattern with inner traversal', () => {
    expect(normalizeScopePattern('src/../lib/**')).toBeNull();
  });
});

// ── Glob boundary cases ───────────────────────────────────────────

describe('glob boundary precision', () => {
  it('src/** does not match src-test/', () => {
    expect(isPathInScope('src-test/foo.ts', ['src/**'])).toBe(false);
  });

  it('src/** does match src/ subdirectories', () => {
    expect(isPathInScope('src/lib/file.ts', ['src/**'])).toBe(true);
  });

  it('*.ts matches all .ts files at any depth', () => {
    expect(isPathInScope('src/foo.ts', ['*.ts'])).toBe(true);
    expect(isPathInScope('src/bar.tsx', ['*.ts'])).toBe(false);
  });

  it('**/*.test.ts matches test files at any depth', () => {
    expect(isPathInScope('src/a.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(isPathInScope('src/lib/a.test.ts', ['**/*.test.ts'])).toBe(true);
    expect(isPathInScope('src/a.ts', ['**/*.test.ts'])).toBe(false);
  });

  it('empty scope patterns match anything', () => {
    expect(isPathInScope('any/path/file.ts', [])).toBe(true);
  });

  it('exact directory scope coverage', () => {
    // src/** matches any file under src/
    expect(isPathInScope('src/file.ts', ['src/**'])).toBe(true);
    // A directory-only path is still within the scope
    expect(isPathInScope('src/subdir/', ['src/**'])).toBe(true);
  });

  it('deeply nested paths still match', () => {
    expect(isPathInScope('a/b/c/d/e/f/g/h/file.ts', ['a/**'])).toBe(true);
  });

  it('normalizes backslash paths', () => {
    expect(isPathInScope('src\\lib\\file.ts', ['src/**'])).toBe(true);
  });
});

// ── Host suffix/port/case normalization ───────────────────────────

describe('host scope precision', () => {
  it('evil-example.com does NOT match example.com', () => {
    expect(isHostInScope('https://evil-example.com', ['example.com'])).toBe(false);
  });

  it('my-example.com does NOT match example.com', () => {
    expect(isHostInScope('https://my-example.com', ['example.com'])).toBe(false);
  });

  it('example.com does NOT match ample.com', () => {
    expect(isHostInScope('https://example.com', ['ample.com'])).toBe(false);
  });

  it('subdomain match requires wildcard', () => {
    expect(isHostInScope('https://sub.example.com', ['example.com'])).toBe(false);
    expect(isHostInScope('https://sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('wildcard does NOT match base domain', () => {
    expect(isHostInScope('https://example.com', ['*.example.com'])).toBe(false);
  });

  it('wildcard matches any single subdomain level', () => {
    expect(isHostInScope('https://api.example.com', ['*.example.com'])).toBe(true);
    expect(isHostInScope('https://x.example.com', ['*.example.com'])).toBe(true);
  });

  it('case insensitive matching', () => {
    expect(isHostInScope('HTTPS://API.EXAMPLE.COM/path', ['api.example.com'])).toBe(true);
  });

  it('port-specific pattern works', () => {
    expect(isHostInScope('https://api.example.com:8080', ['api.example.com:8080'])).toBe(true);
    expect(isHostInScope('https://api.example.com:443', ['api.example.com:8080'])).toBe(false);
  });

  it('port-less pattern matches any port', () => {
    expect(isHostInScope('https://api.example.com:8080', ['api.example.com'])).toBe(true);
    expect(isHostInScope('https://api.example.com:443', ['api.example.com'])).toBe(true);
  });

  it('rejects invalid hostnames', () => {
    expect(normalizeHostPattern('evil<script>.com')).toBeNull();
    expect(normalizeHostPattern('')).toBeNull();
    expect(normalizeHostPattern('not a host!')).toBeNull();
  });

  it('strips protocol and trailing slash', () => {
    expect(normalizeHostPattern('https://api.example.com/')).toBe('api.example.com');
    expect(normalizeHostPattern('http://example.com:8080/v1')).toBeNull(); // has path
  });

  it('rejects hostname with path components', () => {
    expect(normalizeHostPattern('api.example.com/v1/resource')).toBeNull();
  });

  it('rejects port out of range', () => {
    expect(normalizeHostPattern('api.example.com:0')).toBeNull();
    expect(normalizeHostPattern('api.example.com:99999')).toBeNull();
  });
});

// ── Scope intersection edge cases ─────────────────────────────────

describe('scope intersection', () => {
  it('child empty scopes with parent non-empty = child empty (no authority)', () => {
    const result = resolveFilesystemScopes({ read: [] }, { read: ['src/**'] });
    expect(result.resolved).toEqual({ read: [], write: [] });
  });

  it('parent empty scopes deny child non-empty', () => {
    const result = resolveFilesystemScopes({ read: ['src/**'] }, { read: [] });
    expect(result.resolved).toEqual({ read: [], write: [] });
  });

  it('child narrower than parent is kept', () => {
    const result = resolveFilesystemScopes(
      { read: ['src/lib/**'], write: ['out/reports/**'] },
      { read: ['src/**'], write: ['out/**'] },
    );
    expect(result.resolved?.read).toEqual(['src/lib/**']);
    expect(result.resolved?.write).toEqual(['out/reports/**']);
  });

  it('child pattern outside parent is filtered', () => {
    const result = resolveFilesystemScopes({ read: ['src/**', 'docs/**', 'test/**'] }, { read: ['src/**', 'docs/**'] });
    expect(result.resolved?.read).toEqual(['src/**', 'docs/**']);
    expect(result.resolved?.read).not.toContain('test/**');
  });

  it('network wildcard parent covers child subdomain', () => {
    const result = resolveNetworkScopes(
      { hosts: ['api.example.com', 'cdn.example.com'] },
      { hosts: ['*.example.com'] },
    );
    expect(result.resolved).toEqual(['api.example.com', 'cdn.example.com']);
  });

  it('network parent without wildcard denies child subdomain', () => {
    const result = resolveNetworkScopes({ hosts: ['sub.example.com'] }, { hosts: ['example.com'] });
    expect(result.resolved).toEqual([]);
  });
});

// ── Symlink escape defense ───────────────────────────────────────

describe('symlink escape defense', () => {
  let testDir: string;
  let workspaceDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `term2-symlink-test-${process.pid}-${Date.now()}`);
    workspaceDir = path.join(testDir, 'workspace');
    outsideDir = path.join(testDir, 'outside');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    // Create a real file inside workspace
    fs.writeFileSync(path.join(workspaceDir, 'safe.txt'), 'safe');
    // Create a sensitive file outside workspace
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
    setWorkspaceRoot(workspaceDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('resolveRealToolPath follows symlinks and rejects if they escape workspace', async () => {
    // Create a symlink inside workspace that points outside
    const symlinkPath = path.join(workspaceDir, 'link-to-outside');
    const outsideTarget = path.join(outsideDir, 'secret.txt');
    await symlink(outsideTarget, symlinkPath);

    const result = await resolveRealToolPath('link-to-outside');
    expect(result).toBeNull();
  });

  it('resolveRealToolPath allows symlinks that stay within workspace', async () => {
    // Create a symlink inside workspace that points to another file inside workspace
    const targetPath = path.join(workspaceDir, 'subdir', 'target.txt');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, 'target content');
    const symlinkPath = path.join(workspaceDir, 'link-to-target');
    await symlink(targetPath, symlinkPath);

    const result = await resolveRealToolPath('link-to-target');
    expect(result).toBe(targetPath);
  });

  it('resolveRealToolPath resolves nonexistent path via ancestor', async () => {
    // Path doesn't exist yet: should resolve nearest ancestor and verify
    const result = await resolveRealToolPath('subdir/new-file.txt');
    expect(result).toBe(path.resolve(workspaceDir, 'subdir/new-file.txt'));
  });

  it('resolveRealToolPath rejects nonexistent path with symlink ancestor escape', async () => {
    // Create a symlink directory inside workspace that points outside,
    // then try to access a nonexistent file through that symlink
    const symlinkDir = path.join(workspaceDir, 'escape-dir');
    await symlink(outsideDir, symlinkDir);

    const result = await resolveRealToolPath('escape-dir/treasure.txt');
    expect(result).toBeNull();
  });

  it('isPathInScopeSafe uses realpath for symlink-aware scope checking', async () => {
    // Create symlink from workspace to outside
    const symlinkPath = path.join(workspaceDir, 'escape');
    const outsideTarget = path.join(outsideDir, 'secret.txt');
    await symlink(outsideTarget, symlinkPath);

    const result = await isPathInScopeSafe('escape', ['**']);
    expect(result).toBe(false); // Escape detected via realpath
  });

  it('isPathInScopeSafe allows legit file within scope patterns', async () => {
    const result = await isPathInScopeSafe('safe.txt', ['**']);
    expect(result).toBe(true);
  });

  it('resolveRealToolPath rejects traversal through symlink ancestor', async () => {
    // Normalize works, but realpath reveals escape
    const symlinkPath = path.join(workspaceDir, 'evil-link');
    await symlink(outsideDir, symlinkPath);

    // Accessing a nonexistent file under the symlink: resolveRealToolPath
    // should resolve the symlink ancestor and detect it's outside
    const result = await resolveRealToolPath('evil-link/nope.txt');
    expect(result).toBeNull();
  });
});

// ── Redirect behavior documentation ───────────────────────────────

describe('redirect behavior (documented limitation)', () => {
  it('host checking only validates the initial request URL', () => {
    // The current implementation checks the URL passed to the tool,
    // not any redirect target. This is a documented limitation.
    // Redirect bypass is not implemented at the scope level;
    // it is the responsibility of the tool itself (web_fetch) to
    // report redirects or enforce follow limits.
    expect(isHostInScope('https://allowed.com/initial', ['allowed.com'])).toBe(true);
  });

  it('invalid URL input is rejected', () => {
    expect(isHostInScope('not-a-valid-url', ['example.com'])).toBe(false);
  });
});
