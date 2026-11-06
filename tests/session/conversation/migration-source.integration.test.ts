import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../..');
const roots: string[] = [];
const uuid = '11111111-1111-4111-8111-111111111111';
const at = '2026-01-01T00:00:00.000Z';
function fixture(id: string) {
  const root = mkdtempSync(join(tmpdir(), 'term2-migration-source-'));
  roots.push(root);
  const source = join(root, 'source');
  const destination = join(root, 'native');
  const provenance = join(root, 'private', 'map.json');
  mkdirSync(source);
  mkdirSync(destination);
  const bytes =
    JSON.stringify({
      v: 3,
      seq: 0,
      ts: at,
      event: {
        type: 'session_init',
        id,
        createdAt: at,
        projectPath: '/synthetic/workspace',
        activeProfileId: 'builtin:bare',
        provider: 'openai',
        model: 'synthetic-model',
      },
    }) +
    '\n' +
    JSON.stringify({
      v: 3,
      seq: 1,
      ts: at,
      event: {
        type: 'user_message',
        message: { id: 'source-user', sender: 'user', text: 'preserve headless context' },
      },
    }) +
    '\n';
  writeFileSync(join(source, `${id}.jsonl`), bytes);
  const run = () => {
    const result = spawnSync(
      process.execPath,
      [
        join(repo, 'scripts/migrate-conversations.mjs'),
        '--source-copy',
        source,
        '--destination',
        destination,
        '--provenance',
        provenance,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe('');
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  return { root, source, destination, provenance, bytes, run };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('offline migration source identities and locks', () => {
  it('imports a legacy headless ID without colliding with its bare UUID and reruns byte-identically', () => {
    const id = `non-interactive-${uuid}`;
    const f = fixture(id);
    const ordinary = JSON.parse(f.bytes.split('\n')[0]!);
    ordinary.event.id = uuid;
    writeFileSync(join(f.source, `${uuid}.jsonl`), JSON.stringify(ordinary) + '\n');
    expect(f.run()).toMatchObject({ status: 0, report: { counts: { migrated: 2, failed: 0 } } });
    const map = JSON.parse(readFileSync(f.provenance, 'utf8'));
    expect(map.records[uuid].id).toBe(`conv_${uuid}`);
    const mapped = map.records[id].id as string;
    expect(mapped).toMatch(/^conv_[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(mapped).not.toBe(`conv_${uuid}`);
    const native = readFileSync(join(f.destination, `${mapped}.jsonl`));
    expect(native.toString()).toContain('synthetic-model');
    expect(native.toString()).toContain('preserve headless context');
    expect(f.run()).toMatchObject({ status: 0, report: { counts: { noop: 2, migrated: 0 } } });
    expect(readFileSync(join(f.destination, `${mapped}.jsonl`))).toEqual(native);
    expect(readFileSync(join(f.source, `${id}.jsonl`), 'utf8')).toBe(f.bytes);
    // Losing bookkeeping never permits silently adopting an existing target.
    rmSync(f.provenance);
    expect(f.run()).toMatchObject({ status: 2, report: { codes: { FOREIGN_TARGET: 2 } } });
    expect(readFileSync(join(f.destination, `${mapped}.jsonl`))).toEqual(native);
  });

  it('reads a same-host dead-process lock without deleting or changing it', () => {
    const f = fixture(uuid);
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
    expect(child.status).toBe(0);
    const lock = JSON.stringify({ pid: child.pid, startedAt: at, host: hostname() });
    const path = join(f.source, `${uuid}.lock`);
    writeFileSync(path, lock);
    expect(f.run()).toMatchObject({ status: 0, report: { counts: { migrated: 1, skipped: 0 } } });
    expect(readFileSync(path, 'utf8')).toBe(lock);
    expect(readFileSync(join(f.source, `${uuid}.jsonl`), 'utf8')).toBe(f.bytes);
  });

  it.each([
    ['live', (): string => JSON.stringify({ pid: process.pid, startedAt: at, host: hostname() })],
    ['foreign', (): string => JSON.stringify({ pid: 2147483647, startedAt: at, host: `${hostname()}-foreign` })],
    ['invalid pid', (): string => JSON.stringify({ pid: 0, startedAt: at, host: hostname() })],
    ['malformed', (): string => '{'],
    ['oversized', (): string => 'x'.repeat(4097)],
  ] as const)('preserves and refuses an uncertain %s lock', (_name, contents) => {
    const f = fixture(uuid);
    const bytes = contents();
    const path = join(f.source, `${uuid}.lock`);
    writeFileSync(path, bytes);
    expect(f.run()).toMatchObject({
      status: 2,
      report: { counts: { migrated: 0, skipped: 1 }, codes: { SOURCE_LOCKED: 1 } },
    });
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it.each(['directory', 'symlink'] as const)('does not follow a lock %s', (kind) => {
    const f = fixture(uuid);
    const lock = join(f.source, `${uuid}.lock`);
    if (kind === 'directory') mkdirSync(lock);
    else symlinkSync(join(f.root, 'missing'), lock);
    expect(f.run()).toMatchObject({ status: 2, report: { codes: { SOURCE_LOCKED: 1 } } });
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses malformed UTF-8 even inside an otherwise valid stale-lock record', () => {
    const f = fixture(uuid);
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 5_000 });
    expect(child.status).toBe(0);
    const start = JSON.stringify({ pid: child.pid, startedAt: at, host: hostname() }).slice(0, -1);
    const bytes = Buffer.concat([Buffer.from(`${start},"extra":"`), Buffer.from([0xff]), Buffer.from('"}')]);
    const lock = join(f.source, `${uuid}.lock`);
    writeFileSync(lock, bytes);
    expect(f.run()).toMatchObject({ status: 2, report: { codes: { SOURCE_LOCKED: 1 } } });
    expect(readFileSync(lock)).toEqual(bytes);
    expect(readdirSync(f.destination)).toEqual([]);
  });

  it('refuses ownership acquired during conversion before publishing native output', async () => {
    const f = fixture(`non-interactive-${uuid}`);
    const { runMigration } = await import(
      pathToFileURL(join(repo, 'scripts/conversation-migration/migration-command.mjs')).href
    );
    const { convertValidatedV3 } = await import(
      pathToFileURL(join(repo, 'scripts/conversation-migration/v3-to-native.mjs')).href
    );
    const lockPath = join(f.source, `non-interactive-${uuid}.lock`);
    const lock = JSON.stringify({ pid: process.pid, startedAt: at, host: hostname() });
    const result = await runMigration(
      { sourceCopy: f.source, destination: f.destination, provenance: f.provenance },
      {
        convert(input: unknown) {
          const result = convertValidatedV3(input);
          writeFileSync(lockPath, lock);
          return result;
        },
      },
    );
    expect(result).toMatchObject({ counts: { migrated: 0, failed: 1 }, codes: { SOURCE_CHANGED: 1 } });
    expect(readdirSync(f.destination)).toEqual([]);
    expect(readFileSync(lockPath, 'utf8')).toBe(lock);
  });
});
