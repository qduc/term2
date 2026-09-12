import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeWorkspaceRoot,
  createServeSessionLogger,
  loadDynamicWorkspaceGrants,
  prepareGatewayManifest,
  saveDynamicWorkspaceGrants,
  sandboxStartupWarning,
  ServeStartupError,
} from './serve.js';
import { SessionContextService } from '../services/session/session-context-service.js';
import type { WorkspaceGrant } from './contracts.js';

const roots: string[] = [];
const makeRoot = () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'term2-serve-')));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('prepareGatewayManifest', () => {
  it('writes an empty-grant manifest and a matching sha256 sidecar in a fresh state dir', () => {
    const stateDir = makeRoot();
    const { manifestPath, manifestSha256 } = prepareGatewayManifest(stateDir);
    const raw = readFileSync(manifestPath, 'utf8');
    expect(JSON.parse(raw)).toEqual({ version: 1, grants: [], sshTargets: [] });
    expect(createSha256(raw)).toBe(manifestSha256);
    expect(readFileSync(path.join(stateDir, 'manifest.sha256'), 'utf8').trim()).toBe(manifestSha256);
  });

  it('preserves an existing manifest that carries curated grants and refreshes only the sha256', () => {
    const stateDir = makeRoot();
    const curated = {
      version: 1,
      grants: [
        {
          workspaceId: 'ws-curated',
          ownerUserId: 'owner-1',
          label: 'Curated',
          kind: 'local',
          localRoot: stateDir,
          access: 'read',
          enabled: true,
        },
      ],
      sshTargets: [],
    };
    const curatedRaw = `${JSON.stringify(curated, null, 2)}\n`;
    writeFileSync(path.join(stateDir, 'manifest.json'), curatedRaw, 'utf8');

    const { manifestPath, manifestSha256 } = prepareGatewayManifest(stateDir);

    expect(readFileSync(manifestPath, 'utf8')).toBe(curatedRaw);
    expect(manifestSha256).toBe(createSha256(curatedRaw));
    expect(readFileSync(path.join(stateDir, 'manifest.sha256'), 'utf8').trim()).toBe(manifestSha256);
  });

  it('rewrites an existing empty-grant manifest with the canonical form', () => {
    const stateDir = makeRoot();
    writeFileSync(path.join(stateDir, 'manifest.json'), '{"version":1,"grants":[],"sshTargets":[]}', 'utf8');
    const { manifestPath, manifestSha256 } = prepareGatewayManifest(stateDir);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual({ version: 1, grants: [], sshTargets: [] });
    expect(manifestSha256).toBe(createSha256(readFileSync(manifestPath, 'utf8')));
  });

  it('refuses to overwrite an unreadable manifest instead of destroying it', () => {
    const stateDir = makeRoot();
    writeFileSync(path.join(stateDir, 'manifest.json'), '{ not json', 'utf8');
    expect(() => prepareGatewayManifest(stateDir)).toThrow(ServeStartupError);
    expect(readFileSync(path.join(stateDir, 'manifest.json'), 'utf8')).toBe('{ not json');
  });
});

describe('dynamic workspace grant durability', () => {
  const grant = (stateDir: string, workspaceId: string): WorkspaceGrant => ({
    workspaceId,
    ownerUserId: 'owner-1',
    label: 'Selected',
    kind: 'local',
    localRoot: stateDir,
    access: 'read',
    enabled: true,
  });

  it('returns no grants when the file is missing', () => {
    const stateDir = makeRoot();
    expect(loadDynamicWorkspaceGrants(stateDir)).toEqual([]);
  });

  it('saves atomically and round-trips the grant list', () => {
    const stateDir = makeRoot();
    const grants = [grant(stateDir, 'ws_a'), grant(stateDir, 'ws_b')];
    saveDynamicWorkspaceGrants(stateDir, grants);
    expect(loadDynamicWorkspaceGrants(stateDir)).toEqual(grants);
    // No temp file left behind by the rename.
    expect(existsSync(path.join(stateDir, 'dynamic-workspaces.json.tmp'))).toBe(false);
  });

  it('quarantines each damaged file under a unique name so a second incident preserves the first', () => {
    const stateDir = makeRoot();
    const grantsFile = path.join(stateDir, 'dynamic-workspaces.json');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Distinct fake timestamps make the two quarantine names deterministic.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      writeFileSync(grantsFile, '{ first incident', 'utf8');
      expect(loadDynamicWorkspaceGrants(stateDir)).toEqual([]);

      vi.setSystemTime(1_700_000_000_001);
      writeFileSync(grantsFile, '{ second incident', 'utf8');
      expect(loadDynamicWorkspaceGrants(stateDir)).toEqual([]);

      const quarantined = readdirSync(stateDir)
        .filter((name) => name.startsWith('dynamic-workspaces.json.corrupt.'))
        .sort();
      expect(quarantined).toHaveLength(2);
      expect(quarantined.map((name) => readFileSync(path.join(stateDir, name), 'utf8')).sort()).toEqual([
        '{ first incident',
        '{ second incident',
      ]);
      expect(existsSync(grantsFile)).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('moved to'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the damaged file stayed in place when the quarantine move fails', () => {
    const stateDir = makeRoot();
    const grantsFile = path.join(stateDir, 'dynamic-workspaces.json');
    writeFileSync(grantsFile, '{ truncated', 'utf8');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Occupy the predicted quarantine path with a directory so rename(2)
    // fails (EISDIR), regardless of the running user.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_700_000_000_000);
      const predicted = `${grantsFile}.corrupt.1700000000000`;
      mkdirSync(predicted);

      expect(loadDynamicWorkspaceGrants(stateDir)).toEqual([]);

      // The damaged file is still the evidence at the original path.
      expect(readFileSync(grantsFile, 'utf8')).toBe('{ truncated');
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('could not be moved aside'));
      expect(errorSpy).toHaveBeenCalledWith(expect.not.stringContaining('moved to'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when the file parses but carries an invalid grant', () => {
    const stateDir = makeRoot();
    writeFileSync(
      path.join(stateDir, 'dynamic-workspaces.json'),
      JSON.stringify([{ workspaceId: 'bad id with spaces' }]),
      'utf8',
    );
    expect(() => loadDynamicWorkspaceGrants(stateDir)).toThrow(/invalid dynamic grant/);
  });
});

describe('canonicalizeWorkspaceRoot', () => {
  it('resolves symlinks to the canonical directory', () => {
    const stateDir = makeRoot();
    expect(canonicalizeWorkspaceRoot(stateDir)).toBe(stateDir);
  });

  it('refuses a path that is not a usable directory', () => {
    expect(() => canonicalizeWorkspaceRoot('/nonexistent/term2-serve-root')).toThrow(ServeStartupError);
  });
});

describe('sandboxStartupWarning', () => {
  it('is silent when the sandbox runtime is available', () => {
    expect(sandboxStartupWarning({ type: 'available' })).toBeUndefined();
  });

  it('carries the failure type, reason, and consequence for the operator', () => {
    const warning = sandboxStartupWarning({ type: 'missing_dependency', reason: 'socat not installed' });
    expect(warning).toContain('shell sandbox unavailable');
    expect(warning).toContain('missing_dependency');
    expect(warning).toContain('socat not installed');
    expect(warning).toContain('shell tool calls will be refused');
  });

  it('words a probe failure like any other unavailable state', () => {
    const warning = sandboxStartupWarning({ type: 'probe_failed', reason: 'sandbox module threw' });
    expect(warning).toContain('shell sandbox unavailable');
    expect(warning).toContain('probe_failed');
    expect(warning).toContain('sandbox module threw');
    expect(warning).toContain('shell tool calls will be refused');
  });
});

describe('createServeSessionLogger', () => {
  it('writes session log records into the configured log directory', async () => {
    // The serve wiring points per-session loggers at term2's standard log
    // destination; the directory itself is injectable so the test proves the
    // records actually land there instead of being disabled like the previous
    // gateway default.
    const logDir = path.join(makeRoot(), 'logs');
    const logger = createServeSessionLogger(new SessionContextService(), logDir);
    logger.info('session logger wiring probe', { eventType: 'gateway.session_logger.probe' });

    // The transport opens lazily on the first record, so poll until the daily
    // file exists and carries the record.
    await expect
      .poll(() => {
        try {
          const found = readdirSync(logDir).find((f) => f.startsWith('term2-') && f.endsWith('.log'));
          return found ? readFileSync(path.join(logDir, found), 'utf8') : '';
        } catch {
          return '';
        }
      })
      .toContain('session logger wiring probe');
  });
});

function createSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
