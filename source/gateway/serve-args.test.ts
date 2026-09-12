import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SERVE_AUDIENCE, DEFAULT_SERVE_ISSUER, defaultServeStateDir, parseServeArgs } from './serve-args.js';

const STATE_DIR = '/tmp/serve-state';
const BASE = ['--local-owner', 'user-1'];

function ok(argv: string[]) {
  const parsed = parseServeArgs(argv, { stateDir: STATE_DIR });
  if (!parsed.ok) throw new Error(`expected ok, got: ${parsed.error}`);
  return parsed.args;
}

function errorOf(argv: string[]): string {
  const parsed = parseServeArgs(argv, { stateDir: STATE_DIR });
  if (parsed.ok) throw new Error('expected an error');
  return parsed.error;
}

describe('parseServeArgs', () => {
  it('requires --local-owner', () => {
    expect(errorOf([])).toContain('--local-owner');
    expect(errorOf(['--local-owner', '   '])).toContain('--local-owner');
  });

  it('refuses a non-loopback --listen host without --allow-remote', () => {
    expect(errorOf([...BASE, '--listen', '0.0.0.0:9443', '--tls-cert', '/c.pem', '--tls-key', '/k.pem'])).toContain(
      '--allow-remote',
    );
    const args = ok([
      ...BASE,
      '--listen',
      '0.0.0.0:9443',
      '--tls-cert',
      '/c.pem',
      '--tls-key',
      '/k.pem',
      '--allow-remote',
    ]);
    expect(args.transport).toEqual({ kind: 'tls', host: '0.0.0.0', port: 9443, certPath: '/c.pem', keyPath: '/k.pem' });
  });

  it('refuses a relative --socket path', () => {
    expect(errorOf([...BASE, '--socket', 'relative/gateway.sock'])).toContain('absolute');
  });

  it('defaults to a socket under the state dir with the ChatForge BFF issuer and audience', () => {
    const args = ok(BASE);
    expect(args.transport).toEqual({ kind: 'socket', socketPath: path.join(STATE_DIR, 'gateway.sock') });
    expect(args.issuer).toBe(DEFAULT_SERVE_ISSUER);
    expect(args.audience).toBe(DEFAULT_SERVE_AUDIENCE);
    expect(args.pairing).toBe(false);
    expect(args.allowWrite).toBe(false);
  });

  it('rejects mixing the socket and TLS transports', () => {
    expect(errorOf([...BASE, '--socket', '/s.sock', '--listen', '127.0.0.1:9443'])).toContain('mutually exclusive');
  });

  it('requires TLS material for network mode and rejects orphan TLS material', () => {
    expect(errorOf([...BASE, '--listen', '127.0.0.1:9443'])).toContain('--tls-cert');
    expect(errorOf([...BASE, '--tls-cert', '/c.pem', '--tls-key', '/k.pem'])).toContain('--listen');
  });

  it('defaults the TLS host to loopback and accepts bare-port listen specs', () => {
    const args = ok([...BASE, '--listen', ':9443', '--tls-cert', '/c.pem', '--tls-key', '/k.pem']);
    expect(args.transport).toMatchObject({ kind: 'tls', host: '127.0.0.1', port: 9443 });
  });

  it('parses repeatable --bff-key entries and rejects malformed or duplicate kids', () => {
    const args = ok([...BASE, '--bff-key', 'kid-a=/keys/a.pem', '--bff-key', 'kid-b=/keys/b.pem']);
    expect(args.bffKeys).toEqual([
      { kid: 'kid-a', pemPath: '/keys/a.pem' },
      { kid: 'kid-b', pemPath: '/keys/b.pem' },
    ]);
    expect(errorOf([...BASE, '--bff-key', 'no-separator'])).toContain('--bff-key');
    expect(errorOf([...BASE, '--bff-key', '=/keys/a.pem'])).toContain('--bff-key');
    expect(errorOf([...BASE, '--bff-key', 'kid=/keys/a.pem', '--bff-key', 'kid=/keys/b.pem'])).toContain('duplicate');
  });

  it('rejects unexpected positionals, unknown options, and valueless flags', () => {
    expect(errorOf([...BASE, 'prompt'])).toContain('unexpected argument');
    expect(errorOf([...BASE, '--frobnicate'])).toContain('unknown option');
    expect(errorOf([...BASE, '--state-dir'])).toContain('requires a value');
  });

  it('rejects a relative --state-dir and carries --allow-write', () => {
    expect(errorOf(['--local-owner', 'user-1', '--state-dir', 'relative/dir'])).toContain('absolute');
    expect(ok([...BASE, '--allow-write']).allowWrite).toBe(true);
  });

  it('defaults the workspace allowlist to the home directory', () => {
    const args = ok(BASE);
    expect(args.workspaceRoots).toEqual([os.homedir()]);
  });

  it('accepts repeatable --workspace-root entries and rejects relative ones', () => {
    const args = ok([...BASE, '--workspace-root', '/srv/projects', '--workspace-root', '/mnt/work']);
    expect(args.workspaceRoots).toEqual(['/srv/projects', '/mnt/work']);
    expect(errorOf([...BASE, '--workspace-root', 'relative/root'])).toContain('absolute');
  });

  it('derives the default state dir from XDG_STATE_HOME or the home directory', () => {
    expect(defaultServeStateDir({ env: { XDG_STATE_HOME: '/xdg/state' }, homeDir: '/home/u' })).toBe(
      path.join('/xdg/state', 'term2-nodejs', 'gateway'),
    );
    expect(defaultServeStateDir({ env: {}, homeDir: '/home/u' })).toBe(
      path.join('/home/u', '.local', 'state', 'term2-nodejs', 'gateway'),
    );
  });
});
