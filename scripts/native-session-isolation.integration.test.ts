/** Real native filesystem discovery and service isolation; no provider/tool execution. */
import { randomUUID, createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { createDirectRollingLog, readDirectLogLineage, readDirectLogLineages } from '../src/session/rolling-log.js';
import { createDirectSessionStore, type DirectLocalStore } from '../src/session/store.js';
import { listNativeConversations, resolveNativeResume } from '../src/app/cli-conversations.js';
import { parseCommandLine } from '../src/app/cli-args.js';
import { displaySessionId } from '../src/protocol/session-id.js';
import type { SessionStartedFact } from '../src/session/facts.js';
import type { DirectSessionRotationFact } from '../src/session/session-rotation.js';

const model = { provider: 'fixture', model: 'no-provider' };
const profile = { id: 'bare', version: '1', digest: 'isolation-fixture' };
const newId = () => `conv_${randomUUID()}`;
let root: string;
let directory: string;
let store: DirectLocalStore;
let warnings: MockInstance<typeof console.warn>;
let healthy: string;
let rotated: string;
let successor: string;
const logPath = (id: string) => path.join(directory, `${id}.jsonl`);
const metadata = (id: string): SessionStartedFact => ({
  type: 'session_started',
  id,
  workspace: process.cwd(),
  model,
  profile,
  appVersion: 'isolation-fixture',
});
const rotation = (id: string, next: string): DirectSessionRotationFact => ({
  type: 'session_rotated',
  logicalSessionId: id,
  sessionId: next,
  predecessor: { sessionId: id, throughSeq: 2 },
  commandId: 'rotate',
  configuration: { model },
  intent: { modelSelection: model, reasoningEffort: 'default' },
  profile,
  history: [],
});
function seed(id: string, next?: string): void {
  const log = createDirectRollingLog(directory, id);
  log.append([metadata(id)]);
  if (next) {
    log.append([
      {
        type: 'command_started',
        commandId: 'rotate',
        request: { commandId: 'rotate', operation: { kind: 'rollover' } },
        revision: 'fixture-revision',
      },
    ]);
    log.append([
      rotation(id, next),
      { type: 'command_finished', commandId: 'rotate', outcome: { kind: 'rolled_over', sessionId: id } },
    ]);
  }
  log.close();
}
function bytes(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => [
        name,
        createHash('sha256')
          .update(readFileSync(path.join(directory, name)))
          .digest('hex'),
      ]),
  );
}
function options(resumeId: string | null = null) {
  const command = parseCommandLine(['--resume', 'ls']);
  if (command.kind !== 'list-conversations') throw new Error('expected session options');
  return { ...command.options, resumeId };
}
async function healthySurvives(): Promise<void> {
  const before = bytes();
  expect(
    readDirectLogLineages(directory)
      .map((lineage) => lineage.logicalSessionId)
      .sort(),
  ).toEqual([healthy, rotated].sort());
  expect((await store.list()).sessions.map((session) => session.id).sort()).toEqual([healthy, rotated].sort());
  const listing = (await listNativeConversations(directory, options())).map((row) => row.id);
  expect(listing).toContain(displaySessionId(healthy));
  expect(listing).toContain(displaySessionId(rotated));
  expect(listing).not.toContain(displaySessionId(successor));
  for (const [id, logical] of [
    [healthy, healthy],
    [rotated, rotated],
    [successor, rotated],
  ]) {
    expect(readDirectLogLineage(directory, id!).logicalSessionId).toBe(logical);
    expect((await resolveNativeResume(directory, options(id))).resumeId).toBe(logical);
    expect((await store.open(id!)).id).toBe(logical);
  }
  expect(bytes()).toEqual(before);
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'term2-native-isolation-'));
  directory = path.join(root, 'conversations-next');
  mkdirSync(directory);
  healthy = newId();
  rotated = newId();
  successor = newId();
  seed(healthy);
  seed(rotated, successor);
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
  store = createDirectSessionStore({
    directory,
    resolveWorkspace: (root) => ({ target: 'local', root, access: 'read_write' }),
    createRuntime: () => ({
      deps: {
        models: {
          resolve() {
            throw new Error('provider resolution forbidden during open');
          },
          list: () => [],
        },
      },
      request: { instructions: '', tools: [] },
      profile,
      appVersion: 'isolation-fixture',
    }),
  });
});
afterEach(async () => {
  await store?.close();
  warnings?.mockRestore();
  rmSync(root, { recursive: true, force: true });
});
it.each(['JSON', 'UTF-8', 'wrong kind', 'filename mismatch', 'rotation schema', 'root schema'])(
  'reports and isolates a complete malformed %s first header across discovery/list/open',
  async (kind) => {
    const bad = newId();
    const fact =
      kind === 'filename mismatch'
        ? metadata(newId())
        : kind === 'rotation schema'
        ? { type: 'session_rotated', sessionId: bad, predecessor: { sessionId: newId() } }
        : kind === 'root schema'
        ? { type: 'session_started', id: bad }
        : { type: 'not_a_header' };
    const content =
      kind === 'JSON'
        ? '{broken json}\n'
        : kind === 'UTF-8'
        ? Buffer.from([0xff, 0x0a])
        : JSON.stringify({ v: 2, seq: 1, at: new Date().toISOString(), fact }) + '\n';
    writeFileSync(logPath(bad), content);
    await healthySurvives();
    expect(warnings.mock.calls.some((call) => String(call[0]).includes(logPath(bad)))).toBe(true);
    expect(() => readDirectLogLineage(directory, bad)).toThrow();
    await expect(store.open(bad)).rejects.toThrow();
  },
);
it('keeps a malformed required rotation fail-closed without poisoning unrelated roots', async () => {
  const badRoot = newId(),
    badHead = newId();
  seed(badRoot, badHead);
  const raw = JSON.parse(readFileSync(logPath(badHead), 'utf8').split('\n')[0]!);
  delete raw.fact.configuration;
  writeFileSync(logPath(badHead), JSON.stringify(raw) + '\n');
  await healthySurvives();
  for (const id of [badRoot, badHead]) {
    expect(() => readDirectLogLineage(directory, id)).toThrow();
    await expect(store.open(id)).rejects.toThrow();
  }
});
it.each(['filename mismatch', 'divergent successors', 'cycle', 'predecessor appended after rotation'])(
  'keeps related %s fail-closed while unrelated Sessions remain available',
  async (kind) => {
    const badRoot = newId(),
      badHead = newId();
    seed(badRoot, badHead);
    const head = readFileSync(logPath(badHead), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (kind === 'filename mismatch') {
      head[0].fact.sessionId = newId();
      writeFileSync(logPath(badHead), head.map((line) => JSON.stringify(line) + '\n').join(''));
    } else if (kind === 'divergent successors') {
      const extra = newId();
      head[0].fact.sessionId = extra;
      writeFileSync(logPath(extra), head.map((line) => JSON.stringify(line) + '\n').join(''));
    } else if (kind === 'cycle') {
      writeFileSync(
        logPath(badRoot),
        JSON.stringify({
          v: 2,
          seq: 1,
          at: new Date().toISOString(),
          fact: { ...rotation(badRoot, badRoot), predecessor: { sessionId: badHead, throughSeq: 0 } },
        }) + '\n',
      );
    } else {
      appendFileSync(
        logPath(badRoot),
        JSON.stringify({
          v: 2,
          seq: 3,
          at: new Date().toISOString(),
          fact: { type: 'text_delta', turnId: 'late', delta: 'late append' },
        }) + '\n',
      );
    }
    await healthySurvives();
    for (const id of [badRoot, badHead]) {
      expect(() => readDirectLogLineage(directory, id)).toThrow();
      await expect(store.open(id)).rejects.toThrow();
    }
  },
);
it('isolates corruption after a valid first header and never repairs it during discovery', async () => {
  const bad = newId();
  seed(bad);
  appendFileSync(logPath(bad), '{broken interior}\n');
  await healthySurvives();
  expect(warnings.mock.calls.some((call) => String(call[0]).includes(logPath(bad)))).toBe(true);
  await expect(store.open(bad)).rejects.toThrow();
});
it('ignores empty and incomplete first-line creation artifacts without warning', async () => {
  writeFileSync(logPath(newId()), '');
  writeFileSync(logPath(newId()), '{incomplete');
  await healthySurvives();
  expect(warnings).not.toHaveBeenCalled();
});
it('indexes a new first line once its creation artifact is completed', async () => {
  const id = newId();
  const line = JSON.stringify({ v: 2, seq: 1, at: new Date().toISOString(), fact: metadata(id) }) + '\n';
  const split = Math.floor(line.length / 2);
  writeFileSync(logPath(id), line.slice(0, split));
  expect((await listNativeConversations(directory, options())).map((row) => row.id)).not.toContain(
    displaySessionId(id),
  );
  expect(warnings).not.toHaveBeenCalled();
  appendFileSync(logPath(id), line.slice(split));
  expect((await listNativeConversations(directory, options())).map((row) => row.id)).toContain(displaySessionId(id));
  expect(warnings).not.toHaveBeenCalled();
});
it('invalidates a previously indexed session whose first line becomes incomplete', async () => {
  const id = newId();
  seed(id);
  expect((await listNativeConversations(directory, options())).map((row) => row.id)).toContain(displaySessionId(id));
  const original = readFileSync(logPath(id), 'utf8');
  writeFileSync(logPath(id), original.slice(0, Math.floor(original.length / 2)));
  expect((await listNativeConversations(directory, options())).map((row) => row.id)).not.toContain(
    displaySessionId(id),
  );
  writeFileSync(logPath(id), original);
  expect((await listNativeConversations(directory, options())).map((row) => row.id)).toContain(displaySessionId(id));
});
it.each(['foreign entry', 'symlink', 'nonregular log'])('retains global namespace refusal for %s', async (kind) => {
  if (kind === 'foreign entry') writeFileSync(path.join(directory, 'foreign.txt'), 'foreign');
  else if (kind === 'symlink') symlinkSync(logPath(healthy), logPath(newId()));
  else mkdirSync(logPath(newId()));
  expect(() => readDirectLogLineages(directory)).toThrow(/foreign entry|not a regular file/);
  expect(() => readDirectLogLineage(directory, healthy)).toThrow(/foreign entry|not a regular file/);
  await expect(store.list()).rejects.toThrow(/foreign entry|not a regular file/);
  await expect(store.open(healthy)).rejects.toThrow(/foreign entry|not a regular file/);
});
