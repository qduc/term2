import { it, expect, describe } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  detectDeniedRead,
  isSensitiveReadPath,
  suggestStableParent,
  DETAILED_DENIED_READ_INSTRUCTION,
} from './denied-read-detector.js';

const home = os.homedir();

describe('detectDeniedRead', () => {
  it('extracts the path from a macOS file-read* sandbox violation', () => {
    const target = path.join(home, '.local', 'share', 'pnpm', 'store', 'v10', 'files', 'abc');
    const stderr = [
      'ls: cannot access ' + target + ': Operation not permitted',
      '<sandbox_violations>',
      'Sandbox: term2(12345) deny(1) file-read* /Users/user/.local/share/pnpm/store',
      '</sandbox_violations>',
    ].join('\n');
    const info = detectDeniedRead('ls ' + target, stderr);
    expect(info).not.toBeNull();
    expect(info!.path).toBe('/Users/user/.local/share/pnpm/store');
    expect(info!.sensitive).toBe(false);
  });

  it('extracts the path from an alternative macOS denial line format', () => {
    const stderr = [
      '<sandbox_violations>',
      'Sandbox: node(678) deny file-read-data /Users/me/.cargo/registry/cache',
      '</sandbox_violations>',
    ].join('\n');
    const info = detectDeniedRead('cargo build', stderr);
    expect(info).not.toBeNull();
    expect(info!.path).toBe('/Users/me/.cargo/registry/cache');
  });

  it('extracts the path from a Linux permission-denied tool error', () => {
    const target = path.join(home, '.m2', 'repository', 'com', 'example', 'artifact.pom');
    const stderr = `cat: ${target}: Permission denied`;
    const info = detectDeniedRead('cat ' + target, stderr);
    expect(info).not.toBeNull();
    expect(info!.path).toBe(target);
  });

  it('extracts the path from a cannot-open permission-denied error', () => {
    const stderr = "cat: cannot open '/home/user/.config/foo/bar': Permission denied";
    const info = detectDeniedRead('cat /home/user/.config/foo/bar', stderr);
    expect(info).not.toBeNull();
    expect(info!.path).toBe('/home/user/.config/foo/bar');
  });

  it('extracts the path from an "Operation not permitted" error', () => {
    const stderr = 'grep: /home/user/.cargo/registry: Operation not permitted';
    const info = detectDeniedRead('grep foo /home/user/.cargo/registry', stderr);
    expect(info).not.toBeNull();
    expect(info!.path).toBe('/home/user/.cargo/registry');
  });

  it('extracts an existing home path hidden as a bash no-such-file error', () => {
    const target = path.join(home, '.cache');
    const stderr = `/usr/bin/bash: line 1: ${target}: No such file or directory`;
    const info = detectDeniedRead(target, stderr);

    expect(info).not.toBeNull();
    expect(info!.path).toBe(fs.realpathSync(target));
  });

  it('does not treat a true missing path as a denied read', () => {
    const target = path.join(home, '.cache', 'term2-definitely-missing-file');
    const stderr = `/usr/bin/bash: line 1: ${target}: No such file or directory`;
    const info = detectDeniedRead(target, stderr);

    expect(info).toBeNull();
  });

  it('returns null when no denied path can be extracted', () => {
    const stderr = 'some unrelated error output';
    const info = detectDeniedRead('echo hi', stderr);
    expect(info).toBeNull();
  });

  it('returns null for a network-denied sandbox violation with no file path', () => {
    const stderr = [
      'curl: (6) Could not resolve host',
      '<sandbox_violations>',
      'Sandbox: curl(123) deny network-outbound',
      '</sandbox_violations>',
    ].join('\n');
    const info = detectDeniedRead('curl https://example.com', stderr);
    expect(info).toBeNull();
  });

  it('prefers the <sandbox_violations> block on macOS over a generic permission error', () => {
    // Use a non-existent path so realpathSync falls back to path.resolve,
    // making the assertion deterministic across macOS (/etc -> /private/etc symlink).
    const denialPath = '/etc/sandbox-read-hardening-test-nonexistent';
    const stderr = [
      `cat: ${denialPath}: Permission denied`,
      '<sandbox_violations>',
      `Sandbox: cat(123) deny file-read* ${denialPath}`,
      '</sandbox_violations>',
    ].join('\n');
    const info = detectDeniedRead('cat ' + denialPath, stderr);
    expect(info).not.toBeNull();
    expect(info!.path).toBe(denialPath);
  });
});

describe('isSensitiveReadPath', () => {
  it('marks ssh, aws, kube, gnupg, npmrc, pypirc as sensitive', () => {
    expect(isSensitiveReadPath(path.join(home, '.ssh'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.ssh', 'id_rsa'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.aws'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.aws', 'credentials'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.kube'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.kube', 'config'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.gnupg'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.npmrc'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.pypirc'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.docker', 'config.json'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.bash_history'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.zsh_history'))).toBe(true);
  });

  it('marks broad config roots as sensitive', () => {
    expect(isSensitiveReadPath(path.join(home, '.config'))).toBe(true);
    expect(isSensitiveReadPath(path.join(home, '.local'))).toBe(true);
  });

  it('does not mark package-manager stores as sensitive', () => {
    expect(isSensitiveReadPath(path.join(home, '.local', 'share', 'pnpm', 'store'))).toBe(false);
    expect(isSensitiveReadPath(path.join(home, '.cargo'))).toBe(false);
    expect(isSensitiveReadPath(path.join(home, '.m2', 'repository'))).toBe(false);
    expect(isSensitiveReadPath(path.join(home, '.rustup'))).toBe(false);
  });
});

describe('suggestStableParent', () => {
  it('suggests the pnpm store root for a deep pnpm path', () => {
    const deep = path.join(home, '.local', 'share', 'pnpm', 'store', 'v10', 'files', 'abc');
    expect(suggestStableParent(deep)).toBe(path.join(home, '.local', 'share', 'pnpm', 'store'));
  });

  it('suggests ~/.cargo for a deep cargo registry path', () => {
    const deep = path.join(home, '.cargo', 'registry', 'cache', 'index.crates.io');
    expect(suggestStableParent(deep)).toBe(path.join(home, '.cargo'));
  });

  it('suggests ~/.rustup for a deep rustup path', () => {
    const deep = path.join(home, '.rustup', 'toolchains', 'stable-x86_64', 'lib');
    expect(suggestStableParent(deep)).toBe(path.join(home, '.rustup'));
  });

  it('suggests ~/.m2/repository for a deep maven path', () => {
    const deep = path.join(home, '.m2', 'repository', 'com', 'example', 'artifact.pom');
    expect(suggestStableParent(deep)).toBe(path.join(home, '.m2', 'repository'));
  });

  it('suggests ~/.config/gh for a deep gh config path', () => {
    const deep = path.join(home, '.config', 'gh', 'hosts.yml');
    expect(suggestStableParent(deep)).toBe(path.join(home, '.config', 'gh'));
  });

  it('falls back to dirname for unknown paths', () => {
    const deep = path.join(home, '.some-unknown-tool', 'cache', 'data');
    expect(suggestStableParent(deep)).toBe(path.join(home, '.some-unknown-tool', 'cache'));
  });

  it('never collapses to the home root', () => {
    const deep = path.join(home, 'foo', 'bar');
    expect(suggestStableParent(deep)).not.toBe(home);
    expect(suggestStableParent(deep)).not.toBe(path.join(home));
  });

  it('returns the path itself if it is the home root floor', () => {
    // A path that's exactly the home dir: guarded against collapse — return itself to avoid broadening.
    expect(suggestStableParent(home)).toBe(home);
  });
});

describe('DETAILED_DENIED_READ_INSTRUCTION', () => {
  it('instructs the agent to retry', () => {
    expect(DETAILED_DENIED_READ_INSTRUCTION.toLowerCase()).toContain('retry');
  });
});
