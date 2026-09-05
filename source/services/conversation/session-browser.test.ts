import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import { setConversationsDirForTest } from './conversation-persistence.js';
import { SessionBrowser } from './session-browser.js';
import { setTrimConfig, getTrimConfig } from '../../utils/output/output-trim.js';

let dir = '';
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-session-browser-'));
  setConversationsDirForTest(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setConversationsDirForTest(null);
});

function writeSession(id: string, projectPath: string, sshHost?: string, text = 'hello', rolloverFrom?: string) {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    sshHost,
    model: 'model',
    provider: 'provider',
    rolloverFrom,
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u`, sender: 'user', text } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'answer' }] },
    state: { previousResponseId: null },
  });
  void writer.close();
}

function writeRecordSequence(id: string, texts: string[]) {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
  texts.forEach((text, i) => {
    if (i % 2 === 0) writer.append({ type: 'user_message', message: { id: `${id}-u${i}`, sender: 'user', text } });
    else
      writer.append({
        type: 'assistant_turn',
        turn: { items: [{ type: 'assistant_text', text }] },
        state: { previousResponseId: null },
      });
  });
  void writer.close();
}

it('exposes unique UUID short refs and resolves exact, prefix, ambiguous, and previous references', () => {
  const previous = '12345678-1234-4abc-8def-1234567890ab';
  const colliding = '12345678-abcd-4abc-8def-1234567890ab';
  const current = 'abcdef12-3456-4abc-8def-1234567890ab';
  writeSession(previous, '/project', undefined, 'predecessor detail');
  writeSession(colliding, '/project', undefined, 'other detail');
  writeSession(current, '/project', undefined, 'current detail', previous);
  appendEnvelope(current, 99, {
    type: 'session_init',
    id: current,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath: '/project',
  });
  const browser = new SessionBrowser(() => ({ projectPath: '/project', currentSessionId: current }));

  const listed: any = browser.list({});
  const previousEntry = listed.sessions.find((session: any) => session.id === previous);
  expect(previousEntry.shortRef).toBe('12345678-1');
  expect((browser.read({ id: previousEntry.shortRef }) as any).session.id).toBe(previous);
  expect((browser.read({ id: 'previous' }) as any).session).toMatchObject({ id: previous, shortRef: '12345678-1' });
  expect(browser.read({ id: '12345678' })).toMatchObject({
    error: {
      code: 'ambiguous_reference',
      candidates: expect.arrayContaining([
        { id: previous, shortRef: '12345678-1' },
        { id: colliding, shortRef: '12345678-a' },
      ]),
    },
  });
  expect((browser.read({ id: previous }) as any).session.id).toBe(previous);
});

function appendEnvelope(id: string, seq: number, event: unknown, ts = '2026-01-01T00:00:01.000Z') {
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ v: 3, seq, ts, event })}\n`);
}

it('lists and isolates sessions by current local or SSH context', () => {
  writeSession('local', '/project');
  writeSession('remote-a', '/project', ' Host-A ');
  writeSession('remote-b', '/project', 'host-b');
  writeSession('other', '/other');

  expect((new SessionBrowser(() => ({ projectPath: '/project' })).list({}) as any).scope).toBe('/project');
  expect(
    (new SessionBrowser(() => ({ projectPath: '/project' })).list({}) as any).sessions.map(
      (session: any) => session.id,
    ),
  ).toEqual(['local']);
  expect(
    (new SessionBrowser(() => ({ projectPath: '/project', sshHost: 'host-a' })).list({}) as any).sessions.map(
      (session: any) => session.id,
    ),
  ).toEqual(['remote-a']);
  expect(new SessionBrowser(() => ({ projectPath: '/project' })).read({ id: 'remote-a' })).toMatchObject({
    error: { code: 'not_found' },
  });
});

it('includes the browser scope in read results and not-found diagnostics', () => {
  writeSession('other-project', '/other');
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  expect(browser.read({ id: 'missing' })).toMatchObject({
    error: { code: 'not_found', message: expect.stringContaining('/project') },
  });
  expect(browser.read({ id: 'other-project' })).toMatchObject({
    error: {
      code: 'not_found',
      message: expect.stringContaining('/other'),
    },
  });
  expect((browser.read({ id: 'other-project' }) as any).error.message).toContain('/project');
});

it('projects replay messages, searches every kind, and pages oversized text without exposing internals', () => {
  const id = 'project-session';
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
  writer.append({ type: 'user_message', message: { id: 'u', sender: 'user', text: `${'x'.repeat(900)}needle` } });
  writer.append({
    type: 'command_message',
    message: {
      id: 'c',
      sender: 'command',
      status: 'completed',
      command: 'needle tool',
      output: 'tool output',
      toolArgs: { secret: 'hidden' },
    },
  });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: `${'x'.repeat(900)}needle` }] },
    state: { previousResponseId: null },
  });
  void writer.close();
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const search: any = browser.search({ query: 'needle' });
  expect(search.scope).toBe('/project');
  expect(search.results.map((result: any) => result.kind)).toEqual(['user', 'assistant']);
  const first: any = browser.read({ id, maxChars: 512, limit: 20 });
  expect(first.scope).toBe('/project');
  expect(first.items.some((item: any) => item.kind === 'tool' && item.text.includes('hidden'))).toBe(false);
  expect(first.items.some((item: any) => !item.complete && item.text.length > 0)).toBe(true);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(512);
  expect(first.charsUsed).toBe(JSON.stringify(first).length);
});

it('returns short opaque cursors and rejects malformed and stale handles', () => {
  writeSession('session-a', '/project', undefined, 'x'.repeat(900));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  expect(page.nextCursor).toMatch(/^c[0-9a-z]+$/);
  expect(page.nextCursor.length).toBeLessThanOrEqual(8);
  expect(browser.read({ id: 'session-a', cursor: 'bad' })).toMatchObject({ error: { code: 'invalid_cursor' } });
  fs.appendFileSync(
    path.join(dir, 'session-a.jsonl'),
    `${JSON.stringify({
      v: 3,
      seq: 99,
      ts: '2027-01-01T00:00:00.000Z',
      event: { type: 'settings_changed', key: 'agent.model', value: 'new-model' },
    })}\n`,
  );
  expect(browser.read({ id: 'session-a', cursor: page.nextCursor! })).toMatchObject({
    error: { code: 'stale_cursor' },
  });
});

it('binds opaque cursors to their browser and session', () => {
  writeSession('session-a', '/project', undefined, `a😀${'x'.repeat(900)}`);
  writeSession('session-b', '/project', undefined, 'other');
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  expect(browser.read({ id: 'session-a', cursor: `${page.nextCursor}=` })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
  expect(browser.read({ id: 'session-b', cursor: page.nextCursor })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
  expect(
    new SessionBrowser(() => ({ projectPath: '/project' })).read({ id: 'session-a', cursor: page.nextCursor }),
  ).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
});

it('detects transcript changes even when the latest persisted timestamp is unchanged', () => {
  writeSession('session-a', '/project', undefined, 'x'.repeat(900));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  const envelopes = fs.readFileSync(path.join(dir, 'session-a.jsonl'), 'utf8').trim().split('\n');
  const latestTimestamp = JSON.parse(envelopes.at(-1)!).ts;
  appendEnvelope(
    'session-a',
    99,
    { type: 'user_message', message: { id: 'later', sender: 'user', text: 'changed' } },
    latestTimestamp,
  );
  expect(browser.read({ id: 'session-a', cursor: page.nextCursor })).toMatchObject({
    error: { code: 'stale_cursor' },
  });
});

it('invalidates a cached page when the target delta sidecar changes', () => {
  writeSession('session-a', '/project', undefined, 'x'.repeat(900));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  fs.writeFileSync(
    path.join(dir, 'session-a.deltas'),
    `${JSON.stringify({
      v: 3,
      seq: 99,
      ts: '2026-01-01T00:00:01.000Z',
      event: {
        type: 'assistant_journal_delta',
        turnId: 'interrupted-turn',
        seq: 1,
        kind: 'text',
        delta: 'changed in sidecar',
      },
    })}\n`,
  );

  expect(browser.read({ id: 'session-a', cursor: page.nextCursor })).toMatchObject({
    error: { code: 'stale_cursor' },
  });
});

it('projects every supported message kind while excluding provider and tool internals', () => {
  const id = 'all-kinds';
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
  writer.append({ type: 'user_message', message: { id: 'u', sender: 'user', text: 'user text' } });
  writer.append({
    type: 'assistant_turn',
    turn: {
      items: [
        { type: 'reasoning', text: 'reasoning text' },
        { type: 'assistant_text', text: 'assistant text' },
      ],
    },
    state: { previousResponseId: null, history: [{ hidden: 'provider history' }] } as any,
  });
  writer.append({
    type: 'command_message',
    message: {
      id: 'c',
      sender: 'command',
      status: 'completed',
      command: 'tool command',
      output: 'tool output',
      toolArgs: { hidden: 'tool secret' },
      callId: 'hidden-call-id',
    },
  });
  writer.append({ type: 'subagent_started', agentId: 'child', role: 'worker', task: 'subagent task' });
  writer.append({
    type: 'subagent_completed',
    result: { agentId: 'child', role: 'worker', status: 'completed', finalText: 'subagent result', toolsUsed: [] },
  } as any);
  writer.append({ type: 'user_message', message: { id: 'unfinished', sender: 'user', text: 'unfinished' } });
  void writer.close();
  appendEnvelope(id, 99, { type: 'future_provider_state', hidden: 'provider secret' });

  const result: any = new SessionBrowser(() => ({ projectPath: '/project' })).read({ id });
  expect(result.items.map((item: any) => item.kind)).toEqual(
    expect.arrayContaining(['user', 'assistant', 'reasoning', 'system', 'tool', 'subagent']),
  );
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('tool secret');
  expect(serialized).not.toContain('hidden-call-id');
  expect(serialized).not.toContain('provider secret');
  expect(serialized).not.toContain('provider history');
});

it('skips malformed browser projections and reports trustworthy unavailable counts', () => {
  writeSession('valid', '/project');
  fs.writeFileSync(
    path.join(dir, 'malformed.jsonl'),
    [
      { type: 'session_init', id: 'malformed', createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' },
      { type: 'user_message', message: { id: 'u', sender: 'user' } },
    ]
      .map((event, index) => JSON.stringify({ v: 3, seq: index, ts: '2026-01-01T00:00:00.000Z', event }))
      .join('\n'),
  );
  fs.writeFileSync(
    path.join(dir, 'mismatch.jsonl'),
    JSON.stringify({
      v: 3,
      seq: 0,
      ts: '2026-01-01T00:00:00.000Z',
      event: { type: 'session_init', id: 'different', createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' },
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'unsafe.name.jsonl'),
    JSON.stringify({
      v: 3,
      seq: 0,
      ts: '2026-01-01T00:00:00.000Z',
      event: { type: 'session_init', id: 'unsafe.name', createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/other' },
    }),
  );
  fs.mkdirSync(path.join(dir, 'unreadable.jsonl'));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  expect(browser.list({})).toMatchObject({ sessions: [expect.objectContaining({ id: 'valid' })], unavailable: 3 });
  expect(browser.search({ query: 'hello' })).toMatchObject({
    results: [expect.objectContaining({ sessionId: 'valid' })],
    unavailable: 3,
  });
  expect(browser.read({ id: 'malformed' })).toMatchObject({ error: { code: 'session_unavailable' } });
  expect(browser.read({ id: 'unreadable' })).toMatchObject({ error: { code: 'session_unavailable' } });
});

it('recovers all oversized text exactly once with advancing, bounded pages', () => {
  const text = `start😀${'line\\n'.repeat(500)}end`;
  writeSession('paged', '/project', undefined, text);
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const chunks: string[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  do {
    const page: any = browser.read({ id: 'paged', cursor, maxChars: 512, limit: 1 });
    expect(page.error).toBeUndefined();
    expect(page.charsUsed).toBe(JSON.stringify(page).length);
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(512);
    expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(40_000);
    const item = page.items[0];
    if (item.index === 0) chunks.push(item.text);
    cursor = page.nextCursor;
    if (cursor) {
      expect(cursor).toMatch(/^c[0-9a-z]+$/);
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor);
  expect(chunks.join('')).toBe(text);
});

it('reuses the resolved target snapshot across unchanged cursor pages', () => {
  writeSession('paged', '/project', undefined, 'x'.repeat(2_000));
  writeSession('current', '/project', undefined, 'current text', 'paged');
  writeSession('unrelated', '/project', undefined, 'unrelated text');
  const browser = new SessionBrowser(() => ({ projectPath: '/project', currentSessionId: 'current' }));
  const originalReadFileSync = fs.readFileSync;
  const jsonlReads: string[] = [];
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((targetPath, ...args) => {
    if (typeof targetPath === 'string' && targetPath.endsWith('.jsonl')) jsonlReads.push(targetPath);
    return originalReadFileSync(targetPath, ...args);
  });

  try {
    const first: any = browser.read({ id: 'previous', maxChars: 512, limit: 1 });
    expect(first.nextCursor).toBeTruthy();
    expect(jsonlReads.filter((file) => path.basename(file) === 'paged.jsonl')).toHaveLength(1);
    expect(jsonlReads.filter((file) => path.basename(file) === 'unrelated.jsonl')).toHaveLength(1);
    const readsAfterFirstPage = [...jsonlReads];

    const second: any = browser.read({ id: 'previous', cursor: first.nextCursor, maxChars: 512, limit: 1 });
    expect(second.error).toBeUndefined();
    expect(jsonlReads).toEqual(readsAfterFirstPage);
  } finally {
    spy.mockRestore();
  }
});

it('rechecks project authorization when context changes between cursor pages', () => {
  writeSession('paged', '/project', undefined, 'x'.repeat(2_000));
  let context = { projectPath: '/project' };
  const browser = new SessionBrowser(() => context);
  const first: any = browser.read({ id: 'paged', maxChars: 512, limit: 1 });

  context = { projectPath: '/other' };
  expect(browser.read({ id: 'paged', cursor: first.nextCursor, maxChars: 512, limit: 1 })).toMatchObject({
    error: { code: 'not_found', message: expect.stringContaining('/other') },
  });
});

it('re-resolves previous when the current session changes between cursor pages', () => {
  writeSession('first-previous', '/project', undefined, 'x'.repeat(2_000));
  writeSession('new-previous', '/project', undefined, 'replacement');
  writeSession('current', '/project', undefined, 'current', 'first-previous');
  const browser = new SessionBrowser(() => ({ projectPath: '/project', currentSessionId: 'current' }));
  const first: any = browser.read({ id: 'previous', maxChars: 512, limit: 1 });
  appendEnvelope('current', 99, {
    type: 'session_init',
    id: 'current',
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath: '/project',
    rolloverFrom: 'new-previous',
  });

  expect(browser.read({ id: 'previous', cursor: first.nextCursor, maxChars: 512, limit: 1 })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
});

it('reports list totals and counts only budget-dropped entries in omitted', () => {
  writeSession('session-a', '/project');
  writeSession('session-b', '/project');
  writeSession('session-c', '/project');
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const listed: any = browser.list({ limit: 2 });
  expect(listed.total).toBe(3);
  expect(listed.sessions).toHaveLength(2);
  expect(listed.omitted).toBe(0);

  // With limit covering every candidate, anything not emitted was dropped for
  // budget, so omitted must account for exactly the difference.
  const crowded: any = browser.list({ limit: 4, maxChars: 512 });
  expect(crowded.total).toBe(3);
  expect(crowded.sessions.length).toBeLessThan(3);
  expect(crowded.omitted).toBe(3 - crowded.sessions.length);
});

it('demotes current-session search matches below all other sessions', () => {
  writeSession('older', '/project', undefined, 'needle older');
  writeSession('live', '/project', undefined, 'needle live');

  const demoting = new SessionBrowser(() => ({ projectPath: '/project', currentSessionId: 'live' }));
  const results: any = demoting.search({ query: 'needle' });
  expect(results.results[0]!.sessionId).toBe('older');
  expect(results.results.map((result: any) => result.sessionId)).toContain('live');

  const neutral: any = new SessionBrowser(() => ({ projectPath: '/project' })).search({ query: 'needle' });
  expect(neutral.results[0]!.sessionId).toBe('live');
});

it('reports search totals before the limit is applied', () => {
  writeSession('session-a', '/project', undefined, 'needle');
  writeSession('session-b', '/project', undefined, 'needle');
  const result: any = new SessionBrowser(() => ({ projectPath: '/project' })).search({ query: 'needle', limit: 1 });
  expect(result.total).toBe(2);
  expect(result.results).toHaveLength(1);
  expect(result.omitted).toBe(0);
});

it('reports page-local omitted counts so total - omitted equals represented records', () => {
  const id = 'paged-total';
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
  for (let i = 0; i < 4; i++)
    writer.append({ type: 'user_message', message: { id: `u${i}`, sender: 'user', text: `record ${i}` } });
  void writer.close();
  // Closing with an unanswered user message appends an interruption marker,
  // so the projection is 4 user records plus 1 system record.
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const first: any = browser.read({ id, limit: 2 });
  expect(first.total).toBe(5);
  expect(first.items).toHaveLength(2);
  expect(first.omitted).toBe(3);
  expect(first.total - first.omitted).toBe(first.items.length);
  expect(first.nextCursor).toBeTruthy();

  const second: any = browser.read({ id, limit: 2, cursor: first.nextCursor });
  expect(second.items).toHaveLength(2);
  // Page-local: only this page's two represented records count, not the
  // cumulative remaining tail (the superseded cumulative value here was 1).
  expect(second.omitted).toBe(3);
  expect(second.total - second.omitted).toBe(second.items.length);
  expect(second.nextCursor).toBeTruthy();

  const third: any = browser.read({ id, limit: 2, cursor: second.nextCursor });
  expect(third.items).toHaveLength(1);
  expect(third.omitted).toBe(4);
  expect(third.total - third.omitted).toBe(third.items.length);
  expect(third.nextCursor).toBeUndefined();
});

it('anchors an initial from-end read on the last limit projected records in chronological order', () => {
  const id = 'tail-region';
  writeRecordSequence(
    id,
    Array.from({ length: 290 }, (_, i) => `record ${i}`),
  );
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  for (const limit of [5, 10, 20]) {
    const tail: any = browser.read({ id, from: 'end', limit });
    expect(tail.total).toBe(290);
    expect(tail.items).toHaveLength(limit);
    expect(tail.items.map((item: any) => item.index)).toEqual(
      Array.from({ length: limit }, (_, offset) => 290 - limit + offset),
    );
    expect(tail.items.every((item: any) => item.complete)).toBe(true);
    expect(tail.items.at(-1)).toMatchObject({ index: 289, kind: 'assistant', text: 'record 289' });
    expect(tail.omitted).toBe(290 - limit);
    expect(tail.total - tail.omitted).toBe(tail.items.length);
    // The selected tail is consumed: no cursor, and its absence says nothing
    // about the 290 - limit records before the tail anchor.
    expect(tail.nextCursor).toBeUndefined();
  }
});

it('clamps the from-end anchor to the first record on short sessions', () => {
  writeSession('short-tail', '/project', undefined, 'only user text');
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const tail: any = browser.read({ id: 'short-tail', from: 'end', limit: 50 });
  expect(tail.total).toBe(2);
  expect(tail.items.map((item: any) => item.index)).toEqual([0, 1]);
  expect(tail.omitted).toBe(0);
  expect(tail.nextCursor).toBeUndefined();
});

it('returns an empty bounded page for an empty session', () => {
  const writer = createConversationLogWriter({ sessionId: 'empty-session', dir, logger });
  writer.init({ id: 'empty-session', createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
  void writer.close();
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const result: any = browser.read({ id: 'empty-session', from: 'end' });
  expect(result.total).toBe(0);
  expect(result.items).toEqual([]);
  expect(result.omitted).toBe(0);
  expect(result.nextCursor).toBeUndefined();
});

it('pages a constrained-budget tail through its region without loss, duplication, or reverse ordering', () => {
  const id = 'tail-walk';
  const texts = Array.from({ length: 290 }, (_, i) =>
    i < 285 ? `record ${i}` : `record ${i} 😀${'x'.repeat(900)}😀${'y'.repeat(900)}😀 tail-${i}`,
  );
  writeRecordSequence(id, texts);
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const first: any = browser.read({ id, from: 'end', limit: 10, maxChars: 512 });
  expect(first.error).toBeUndefined();
  expect(first.items[0]!.index).toBe(280);
  expect(first.total).toBe(290);

  const reassembled = new Map<number, string>();
  const completed = new Set<number>();
  let previousIndex = -1;
  const collect = (page: any) => {
    expect(page.total - page.omitted).toBe(page.items.length);
    for (const item of page.items) {
      expect(item.index).toBeGreaterThanOrEqual(previousIndex);
      previousIndex = item.index;
      const prior = reassembled.get(item.index) ?? '';
      expect(item.textOffset).toBe(prior.length);
      reassembled.set(item.index, prior + item.text);
      if (item.complete) expect(completed.has(item.index)).toBe(false);
      if (item.complete) completed.add(item.index);
    }
  };
  collect(first);
  let cursor: string | undefined = first.nextCursor;
  let pages = 1;
  while (cursor) {
    const page: any = browser.read({ id, cursor, maxChars: 512 });
    expect(page.error).toBeUndefined();
    collect(page);
    pages++;
    expect(pages).toBeLessThan(200);
    cursor = page.nextCursor;
  }

  expect(completed.size).toBe(10);
  for (let i = 280; i < 290; i++) expect(reassembled.get(i)).toBe(texts[i]);
  // Tail consumed: no cursor remains even though records 0..279 were never shown.
  expect(cursor).toBeUndefined();
});

it('chunks an oversized final record and drops the cursor only when the tail is consumed', () => {
  const id = 'tail-final';
  const finalText = `fin😀${'x'.repeat(1500)}😀ish`;
  writeRecordSequence(id, ['lead one', 'lead two', 'lead three', finalText]);
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const first: any = browser.read({ id, from: 'end', limit: 1, maxChars: 512 });
  expect(first.items).toHaveLength(1);
  expect(first.items[0]).toMatchObject({ index: 3, kind: 'assistant', complete: false, textOffset: 0 });
  expect(first.total).toBe(4);
  expect(first.total - first.omitted).toBe(1);
  expect(first.nextCursor).toBeTruthy();

  const chunks = [first.items[0].text];
  const completeness = [first.items[0].complete];
  let cursor: string | undefined = first.nextCursor;
  while (cursor) {
    const page: any = browser.read({ id, cursor, maxChars: 512 });
    expect(page.error).toBeUndefined();
    expect(page.items).toHaveLength(1);
    expect(page.items[0].index).toBe(3);
    expect(page.total - page.omitted).toBe(1);
    chunks.push(page.items[0].text);
    completeness.push(page.items[0].complete);
    cursor = page.nextCursor;
  }
  // Only the final chunk is complete; UTF-16 surrogate pairs survive chunking.
  expect(completeness.slice(0, -1)).toEqual(completeness.slice(0, -1).map(() => false));
  expect(completeness.at(-1)).toBe(true);
  expect(chunks.join('')).toBe(finalText);
  expect(cursor).toBeUndefined();
});

it('anchors skipped-record projections by projected ordinal while keeping original indexes', () => {
  const id = 'skipped-records';
  const events: Array<Record<string, unknown>> = [
    { type: 'session_init', id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' },
  ];
  for (let i = 0; i < 12; i++) {
    events.push({ type: 'user_message', message: { id: `u${i}`, sender: 'user', text: `record ${i}` } });
    if (i % 4 === 0)
      events.push({
        type: 'user_message',
        message: { id: `future-${i}`, sender: 'future-telemetry', text: 'internal only' },
      });
  }
  events.push({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'closing answer' }] },
    state: { previousResponseId: null },
  });
  fs.writeFileSync(
    path.join(dir, `${id}.jsonl`),
    events.map((event, seq) => JSON.stringify({ v: 3, seq, ts: '2026-01-01T00:00:01.000Z', event })).join('\n') + '\n',
  );
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  const tail: any = browser.read({ id, from: 'end', limit: 5 });
  expect(tail.total).toBe(13);
  expect(tail.skippedMessageCount).toBe(3);
  expect(tail.items).toHaveLength(5);
  // Projected ordinals 8..12 map to original message indexes 10, 12, 13, 14,
  // and 15: the three skipped records at original indexes 1, 6, and 11 stay
  // excluded from the projection but keep the surviving records' original
  // indexes intact.
  expect(tail.items.map((item: any) => item.index)).toEqual([10, 12, 13, 14, 15]);
  expect(tail.omitted).toBe(8);
  expect(tail.total - tail.omitted).toBe(tail.items.length);
});

it('rejects combining a tail anchor with a cursor continuation', () => {
  writeSession('tail-cursor', '/project', undefined, 'x'.repeat(900));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const first: any = browser.read({ id: 'tail-cursor', maxChars: 512 });

  expect(browser.read({ id: 'tail-cursor', from: 'end', cursor: first.nextCursor })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
});

it('counts a chunked record as represented on its partial page', () => {
  writeSession('chunky', '/project', undefined, 'x'.repeat(900));
  const page: any = new SessionBrowser(() => ({ projectPath: '/project' })).read({ id: 'chunky', maxChars: 512 });
  expect(page.total).toBe(2);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.complete).toBe(false);
  // Page-local: the partial chunk represents its record, so exactly one of the
  // two whole-session records is represented here.
  expect(page.omitted).toBe(1);
  expect(page.total - page.omitted).toBe(page.items.length);
});

it('returns a coherent bounded failure when the runtime byte cap is tiny', () => {
  const original = getTrimConfig();
  try {
    const minimal = JSON.stringify({ error: { code: 'output_budget_exceeded' } });
    setTrimConfig({ maxCharacters: minimal.length });
    writeSession('minimal-cap', '/project');
    expect(new SessionBrowser(() => ({ projectPath: '/project' })).list({})).toEqual({
      error: { code: 'output_budget_exceeded' },
    });

    setTrimConfig({ maxCharacters: 1 });
    writeSession('tiny-cap', '/project');
    const result = new SessionBrowser(() => ({ projectPath: '/project' })).list({});
    expect(JSON.stringify(result)).toBe('0');
  } finally {
    setTrimConfig(original);
  }
});

it('does not create persistence directories while browsing', () => {
  const missing = path.join(dir, 'missing');
  setConversationsDirForTest(missing);
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));

  expect(browser.list({})).toMatchObject({ sessions: [] });
  expect(browser.read({ id: 'missing' })).toMatchObject({ error: { code: 'not_found' } });
  expect(fs.existsSync(missing)).toBe(false);
});
