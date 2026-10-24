import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from './conversation-persistence.js';
import { SessionBrowser } from './session-browser.js';
import { SessionIndexService } from './session-index/session-index-service.js';

const dirs: string[] = [];
afterEach(() => {
  setConversationsDirForTest(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('reads explicit references without building the search index, retaining scoped collision refs and worker cursors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-read-reference-'));
  dirs.push(dir);
  setConversationsDirForTest(dir);
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;
  const a = '12345678-1111-4111-8111-111111111111';
  const b = '12345678-2222-4222-8222-222222222222';
  const outside = 'abcdefab-1111-4111-8111-111111111111';
  for (const id of [a, b, outside, 'unrelated']) {
    const writer = createConversationLogWriter({ sessionId: id, dir, logger });
    writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: id === outside ? '/other' : '/project' });
    for (let n = 0; n < 3; n++) {
      writer.append({ type: 'user_message', message: { id: `${id}-${n}`, sender: 'user', text: `${id}: ${n}` } });
    }
    await writer.close();
  }
  const dbPath = path.join(dir, 'must-not-build.db');
  const service = new SessionIndexService({ backend: 'direct', dbPath, conversationsDir: dir });
  const context = () => ({ projectPath: '/project' });
  const indexed = new SessionBrowser(context, { backend: 'indexed', indexService: service });
  const canonical = new SessionBrowser(context, { backend: 'canonical' });
  try {
    const first = (await indexed.read({ id: a, limit: 1 })) as any;
    const readSpy = vi.spyOn(fs, 'readFileSync');
    let expected: any;
    try {
      expected = canonical.read({ id: a, limit: 1 });
      const readPaths = readSpy.mock.calls.map(([file]) => String(file));
      expect(readPaths).toContain(path.join(dir, `${a}.jsonl`));
      expect(readPaths).toContain(path.join(dir, `${b}.jsonl`));
      expect(readPaths).not.toContain(path.join(dir, 'unrelated.jsonl'));
      expect(readPaths).not.toContain(path.join(dir, `${outside}.jsonl`));
    } finally {
      readSpy.mockRestore();
    }
    expect({ ...first, nextCursor: undefined }).toEqual({ ...expected, nextCursor: undefined });
    expect(first.session.shortRef).toBe('12345678-1');
    const next = (await indexed.read({ id: a, cursor: first.nextCursor, limit: 1 })) as any;
    expect(next.items[0].text).toBe(`${a}: 1`);
    const ambiguous = (await indexed.read({ id: '12345678' })) as any;
    expect(ambiguous.error.code).toBe('ambiguous_reference');
    expect(ambiguous.error.candidates.map((candidate: { id: string }) => candidate.id).sort()).toEqual([a, b]);
    expect((await indexed.read({ id: outside })) as any).toMatchObject({ error: { code: 'not_found' } });
    expect((await indexed.read({ id: 'missing' })) as any).toMatchObject({ error: { code: 'not_found' } });
    expect(fs.existsSync(dbPath)).toBe(false);
  } finally {
    await indexed.close();
    await canonical.close();
    await service.close();
  }
});
