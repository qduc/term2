import { describe, it, expect, beforeEach } from 'vitest';
import {
  normalizeToolPath,
  normalizeScopePattern,
  normalizeHostPattern,
  isPathInScope,
  isHostInScope,
  resolveFilesystemScopes,
  resolveNetworkScopes,
  isFilesystemScopeEmpty,
  isNetworkScopeEmpty,
  setWorkspaceRoot,
  getWorkspaceRoot,
} from './scope-resolver.js';
import path from 'node:path';
import os from 'node:os';

const TEST_ROOT = path.resolve(os.tmpdir(), 'term2-scope-test-' + process.pid);

beforeEach(() => {
  setWorkspaceRoot(TEST_ROOT);
});

describe('normalizeToolPath', () => {
  it('resolves a relative path within workspace', () => {
    const result = normalizeToolPath('src/file.ts');
    expect(result).toBe(path.resolve(TEST_ROOT, 'src/file.ts'));
  });

  it('resolves absolute path within workspace', () => {
    const absPath = path.resolve(TEST_ROOT, 'src/file.ts');
    const result = normalizeToolPath(absPath);
    expect(result).toBe(absPath);
  });

  it('rejects traversal that escapes workspace', () => {
    const result = normalizeToolPath('../etc/passwd');
    expect(result).toBeNull();
  });

  it('rejects deeply nested traversal escape', () => {
    const result = normalizeToolPath('src/../../../etc/passwd');
    expect(result).toBeNull();
  });

  it('rejects absolute path outside workspace', () => {
    const result = normalizeToolPath('/etc/passwd');
    expect(result).toBeNull();
  });

  it('rejects null bytes', () => {
    const result = normalizeToolPath('src/\x00evil');
    expect(result).toBeNull();
  });

  it('rejects empty string', () => {
    const result = normalizeToolPath('');
    expect(result).toBeNull();
  });

  it('allows path that stays within workspace with .. that does not escape', () => {
    const result = normalizeToolPath('src/../src/file.ts');
    expect(result).toBe(path.resolve(TEST_ROOT, 'src/file.ts'));
  });
});

describe('normalizeScopePattern', () => {
  it('normalizes a valid relative pattern', () => {
    expect(normalizeScopePattern('src/**')).toBe('src/**');
  });

  it('strips leading/trailing whitespace', () => {
    expect(normalizeScopePattern('  src/**  ')).toBe('src/**');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeScopePattern('src\\lib\\**')).toBe('src/lib/**');
  });

  it('rejects absolute patterns', () => {
    expect(normalizeScopePattern('/src/**')).toBeNull();
  });

  it('rejects patterns with traversal', () => {
    expect(normalizeScopePattern('../src/**')).toBeNull();
  });

  it('rejects patterns with inner traversal', () => {
    expect(normalizeScopePattern('src/../lib/**')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(normalizeScopePattern('')).toBeNull();
  });

  it('rejects whitespace-only', () => {
    expect(normalizeScopePattern('   ')).toBeNull();
  });

  it('accepts pattern with single *', () => {
    expect(normalizeScopePattern('*.ts')).toBe('*.ts');
  });

  it('accepts pattern at root level', () => {
    expect(normalizeScopePattern('src/**/*.ts')).toBe('src/**/*.ts');
  });
});

describe('isPathInScope', () => {
  it('returns true for path matching exact pattern', () => {
    expect(isPathInScope('src/file.ts', ['src/**'])).toBe(true);
  });

  it('returns true for nested path matching glob', () => {
    expect(isPathInScope('src/lib/deep/file.ts', ['src/**'])).toBe(true);
  });

  it('returns false for path outside scope', () => {
    expect(isPathInScope('other/file.ts', ['src/**'])).toBe(false);
  });

  it('returns true when scopes are empty (no restriction)', () => {
    expect(isPathInScope('any/file.ts', [])).toBe(true);
  });

  it('returns false for traversal path', () => {
    expect(isPathInScope('../etc/passwd', ['src/**'])).toBe(false);
  });

  it('matches file pattern without directory prefix', () => {
    expect(isPathInScope('src/foo.ts', ['*.ts'])).toBe(true);
    expect(isPathInScope('src/foo.txt', ['*.ts'])).toBe(false);
  });

  it('matches deep nested paths with **', () => {
    expect(isPathInScope('a/b/c/d/file.ts', ['a/**'])).toBe(true);
  });

  it('matches multiple patterns', () => {
    expect(isPathInScope('docs/readme.md', ['src/**', 'docs/**'])).toBe(true);
    expect(isPathInScope('test/foo.ts', ['src/**', 'docs/**'])).toBe(false);
  });

  it('rejects path with traversal even if pattern is broad', () => {
    expect(isPathInScope('../../../etc/passwd', ['**'])).toBe(false);
  });

  it('matches extension pattern', () => {
    expect(isPathInScope('src/components/Button.tsx', ['**/*.tsx'])).toBe(true);
    expect(isPathInScope('src/components/Button.ts', ['**/*.tsx'])).toBe(false);
  });

  it('does not match partial directory name', () => {
    // 'src-test/foo.ts' should NOT match 'src/**'
    expect(isPathInScope('src-test/foo.ts', ['src/**'])).toBe(false);
  });

  it('normalizes backslash paths', () => {
    expect(isPathInScope('src\\lib\\file.ts', ['src/**'])).toBe(true);
  });
});

describe('normalizeHostPattern', () => {
  it('normalizes a simple hostname', () => {
    expect(normalizeHostPattern('api.example.com')).toBe('api.example.com');
  });

  it('lowercases', () => {
    expect(normalizeHostPattern('API.Example.COM')).toBe('api.example.com');
  });

  it('strips protocol prefix', () => {
    expect(normalizeHostPattern('https://api.example.com')).toBe('api.example.com');
  });

  it('strips trailing slash', () => {
    expect(normalizeHostPattern('api.example.com/')).toBe('api.example.com');
  });

  it('preserves port', () => {
    expect(normalizeHostPattern('api.example.com:8080')).toBe('api.example.com:8080');
  });

  it('rejects paths', () => {
    expect(normalizeHostPattern('api.example.com/v1')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(normalizeHostPattern('')).toBeNull();
  });

  it('rejects invalid port', () => {
    expect(normalizeHostPattern('api.example.com:99999')).toBeNull();
  });

  it('rejects non-numeric port', () => {
    expect(normalizeHostPattern('api.example.com:abc')).toBeNull();
  });

  it('rejects hostname with special characters', () => {
    expect(normalizeHostPattern('evil<script>.com')).toBeNull();
  });

  it('accepts wildcard hostname', () => {
    expect(normalizeHostPattern('*.example.com')).toBe('*.example.com');
  });

  it('rejects bare wildcard', () => {
    expect(normalizeHostPattern('*')).toBeNull();
  });
});

describe('isHostInScope - suffix confusion prevention', () => {
  it('evil-example.com does NOT match example.com', () => {
    expect(isHostInScope('https://evil-example.com', ['example.com'])).toBe(false);
  });

  it('example.com matches example.com', () => {
    expect(isHostInScope('https://example.com', ['example.com'])).toBe(true);
  });

  it('subdomain of example.com does NOT match example.com (no wildcard)', () => {
    expect(isHostInScope('https://sub.example.com', ['example.com'])).toBe(false);
  });

  it('*.example.com matches sub.example.com', () => {
    expect(isHostInScope('https://sub.example.com', ['*.example.com'])).toBe(true);
  });

  it('*.example.com does NOT match example.com itself', () => {
    expect(isHostInScope('https://example.com', ['*.example.com'])).toBe(false);
  });

  it('myexample.com does NOT match example.com', () => {
    expect(isHostInScope('https://myexample.com', ['example.com'])).toBe(false);
  });

  it('case insensitive matching', () => {
    expect(isHostInScope('https://API.Example.COM', ['api.example.com'])).toBe(true);
  });

  it('port-specific matching', () => {
    expect(isHostInScope('https://api.example.com:8080', ['api.example.com:8080'])).toBe(true);
    expect(isHostInScope('https://api.example.com:443', ['api.example.com:8080'])).toBe(false);
  });

  it('port-agnostic pattern matches any port', () => {
    expect(isHostInScope('https://api.example.com:8080', ['api.example.com'])).toBe(true);
  });

  it('empty allowed patterns = no restriction', () => {
    expect(isHostInScope('https://any.evil.com', [])).toBe(true);
  });

  it('bare hostname input works', () => {
    expect(isHostInScope('api.example.com', ['api.example.com'])).toBe(true);
  });

  it('invalid URLs return false', () => {
    expect(isHostInScope('not a url', ['example.com'])).toBe(false);
  });

  it('strip port from bare hostname', () => {
    expect(isHostInScope('api.example.com:8080', ['api.example.com'])).toBe(true);
  });

  it('literal * wildcard matches any host', () => {
    expect(isHostInScope('https://api.example.com', ['*'])).toBe(true);
    expect(isHostInScope('https://evil.com', ['*'])).toBe(true);
    expect(isHostInScope('https://any-sub.domain.org', ['*'])).toBe(true);
    expect(isHostInScope('https://localhost:3000', ['*'])).toBe(true);
  });

  it('literal * wildcard accepts any string (all hosts)', () => {
    // The '*' wildcard short-circuits hostname validation — it means "all hosts".
    expect(isHostInScope('anything at all', ['*'])).toBe(true);
    expect(isHostInScope('https://any.host.example.com:1234/path', ['*'])).toBe(true);
  });
});

describe('resolveFilesystemScopes', () => {
  it('returns undefined when no scopes provided', () => {
    const result = resolveFilesystemScopes(undefined, undefined);
    expect(result.resolved).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('resolves child scopes alone', () => {
    const result = resolveFilesystemScopes({ read: ['src/**'], write: ['out/**'] });
    expect(result.resolved).toEqual({ read: ['src/**'], write: ['out/**'] });
    expect(result.errors).toEqual([]);
  });

  it('intersects child with parent scopes', () => {
    const result = resolveFilesystemScopes({ read: ['src/**', 'docs/**'] }, { read: ['src/**'] });
    expect(result.resolved).toEqual({ read: ['src/**'], write: [] });
    expect(result.errors).toEqual([]);
  });

  it('child pattern outside parent scope is filtered out', () => {
    const result = resolveFilesystemScopes({ read: ['src/**', 'test/**'] }, { read: ['src/**'] });
    expect(result.resolved?.read).toEqual(['src/**']);
    expect(result.resolved?.read).not.toContain('test/**');
  });

  it('child with empty scopes inherits parent', () => {
    const result = resolveFilesystemScopes(undefined, { read: ['src/**'], write: ['out/**'] });
    expect(result.resolved).toEqual({ read: ['src/**'], write: ['out/**'] });
  });

  it('empty child read array means no read authority', () => {
    const result = resolveFilesystemScopes({ read: [] });
    expect(result.resolved).toEqual({ read: [], write: [] });
  });

  it('empty parent scopes deny all child scopes', () => {
    const result = resolveFilesystemScopes({ read: ['src/**'] }, { read: [] });
    expect(result.resolved?.read).toEqual([]);
  });

  it('rejects invalid patterns', () => {
    const result = resolveFilesystemScopes({ read: ['/etc/passwd'] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalid_scope_pattern');
  });

  it('accumulates errors for multiple invalid patterns', () => {
    const result = resolveFilesystemScopes({ read: ['/etc/passwd'], write: ['../outside'] });
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].field).toBe('filesystem.read');
    expect(result.errors[1].field).toBe('filesystem.write');
  });

  it('child write sub-pattern of parent write is kept', () => {
    const result = resolveFilesystemScopes({ write: ['src/lib/**'] }, { write: ['src/**'] });
    expect(result.resolved?.write).toEqual(['src/lib/**']);
  });

  it('intersects separate read and write scopes independently', () => {
    const result = resolveFilesystemScopes(
      { read: ['src/**', 'docs/**'], write: ['out/**'] },
      { read: ['src/**'], write: ['out/**'] },
    );
    expect(result.resolved?.read).toEqual(['src/**']);
    expect(result.resolved?.write).toEqual(['out/**']);
  });
});

describe('resolveNetworkScopes', () => {
  it('returns undefined when no scopes provided', () => {
    const result = resolveNetworkScopes(undefined, undefined);
    expect(result.resolved).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('resolves child hosts alone', () => {
    const result = resolveNetworkScopes({ hosts: ['api.example.com', 'cdn.example.com'] });
    expect(result.resolved).toEqual(['api.example.com', 'cdn.example.com']);
    expect(result.errors).toEqual([]);
  });

  it('normalizes hostnames', () => {
    const result = resolveNetworkScopes({ hosts: ['API.Example.COM'] });
    expect(result.resolved).toEqual(['api.example.com']);
  });

  it('intersects child with parent hosts', () => {
    const result = resolveNetworkScopes({ hosts: ['api.example.com', 'other.com'] }, { hosts: ['api.example.com'] });
    expect(result.resolved).toEqual(['api.example.com']);
  });

  it('child inherits parent when child undefined', () => {
    const result = resolveNetworkScopes(undefined, { hosts: ['api.example.com'] });
    expect(result.resolved).toEqual(['api.example.com']);
  });

  it('empty child hosts means no network authority', () => {
    const result = resolveNetworkScopes({ hosts: [] });
    expect(result.resolved).toEqual([]);
  });

  it('rejects invalid host patterns', () => {
    const result = resolveNetworkScopes({ hosts: ['not a host!'] });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('invalid_scope_pattern');
  });

  it('wildcard parent covers child subdomain', () => {
    const result = resolveNetworkScopes({ hosts: ['sub.example.com'] }, { hosts: ['*.example.com'] });
    expect(result.resolved).toEqual(['sub.example.com']);
  });
});

describe('isFilesystemScopeEmpty', () => {
  it('returns false for undefined scope', () => {
    expect(isFilesystemScopeEmpty(undefined)).toBe(false);
  });

  it('returns true when both read and write are empty', () => {
    expect(isFilesystemScopeEmpty({ read: [], write: [] })).toBe(true);
  });

  it('returns false when read has patterns', () => {
    expect(isFilesystemScopeEmpty({ read: ['src/**'], write: [] })).toBe(false);
  });
});

describe('isNetworkScopeEmpty', () => {
  it('returns false for undefined scope', () => {
    expect(isNetworkScopeEmpty(undefined)).toBe(false);
  });

  it('returns true when hosts is empty array', () => {
    expect(isNetworkScopeEmpty([])).toBe(true);
  });

  it('returns false when hosts has patterns', () => {
    expect(isNetworkScopeEmpty(['api.example.com'])).toBe(false);
  });
});
