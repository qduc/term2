import { afterEach, beforeEach, expect, it } from 'vitest';
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

function writeSession(id: string, projectPath: string, sshHost?: string, text = 'hello') {
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    sshHost,
    model: 'model',
    provider: 'provider',
  });
  writer.append({ type: 'user_message', message: { id: `${id}-u`, sender: 'user', text } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'answer' }] },
    state: { previousResponseId: null },
  });
  void writer.close();
}

function appendEnvelope(id: string, seq: number, event: unknown, ts = '2026-01-01T00:00:01.000Z') {
  fs.appendFileSync(path.join(dir, `${id}.jsonl`), `${JSON.stringify({ v: 3, seq, ts, event })}\n`);
}

it('lists and isolates sessions by current local or SSH context', () => {
  writeSession('local', '/project');
  writeSession('remote-a', '/project', ' Host-A ');
  writeSession('remote-b', '/project', 'host-b');
  writeSession('other', '/other');

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
  expect(search.results.map((result: any) => result.kind)).toEqual(['user', 'assistant']);
  const first: any = browser.read({ id, maxChars: 512, limit: 20 });
  expect(first.items.some((item: any) => item.kind === 'tool' && item.text.includes('hidden'))).toBe(false);
  expect(first.items.some((item: any) => !item.complete && item.text.length > 0)).toBe(true);
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(512);
  expect(first.charsUsed).toBe(JSON.stringify(first).length);
});

it('rejects malformed and stale cursors with sanitized errors', () => {
  writeSession('session-a', '/project', undefined, 'x'.repeat(900));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  expect(page.nextCursor).toBeTruthy();
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

it('rejects noncanonical, cross-session, terminal, and split-surrogate cursors', () => {
  writeSession('session-a', '/project', undefined, `a😀${'x'.repeat(900)}`);
  writeSession('session-b', '/project', undefined, 'other');
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  expect(browser.read({ id: 'session-a', cursor: `${page.nextCursor}=` })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
  const decoded = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'));
  const cursor = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  expect(browser.read({ id: 'session-b', cursor: page.nextCursor })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
  expect(browser.read({ id: 'session-a', cursor: cursor({ ...decoded, nextTextOffset: 2 }) })).toMatchObject({
    error: { code: 'invalid_cursor' },
  });
  expect(
    browser.read({
      id: 'session-a',
      cursor: cursor({ ...decoded, nextIndex: 2, nextTextOffset: 1 }),
    }),
  ).toMatchObject({ error: { code: 'invalid_cursor' } });
});

it('detects transcript changes even when the latest persisted timestamp is unchanged', () => {
  writeSession('session-a', '/project', undefined, 'x'.repeat(900));
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const page: any = browser.read({ id: 'session-a', maxChars: 512 });
  const cursorState = JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'));
  appendEnvelope(
    'session-a',
    99,
    { type: 'user_message', message: { id: 'later', sender: 'user', text: 'changed' } },
    cursorState.updatedAt,
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
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  expect(browser.list({})).toMatchObject({ sessions: [expect.objectContaining({ id: 'valid' })], unavailable: 2 });
  expect(browser.search({ query: 'hello' })).toMatchObject({
    results: [expect.objectContaining({ sessionId: 'valid' })],
    unavailable: 2,
  });
  expect(browser.read({ id: 'malformed' })).toMatchObject({ error: { code: 'session_unavailable' } });
});

it('recovers all oversized text exactly once with advancing, bounded pages', () => {
  const text = `start😀${'line\\n'.repeat(500)}end`;
  writeSession('paged', '/project', undefined, text);
  const browser = new SessionBrowser(() => ({ projectPath: '/project' }));
  const chunks: string[] = [];
  let cursor: string | undefined;
  let previous: [number, number] = [-1, -1];
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
      const state = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      expect(
        state.nextIndex > previous[0] || (state.nextIndex === previous[0] && state.nextTextOffset > previous[1]),
      ).toBe(true);
      previous = [state.nextIndex, state.nextTextOffset];
    }
  } while (cursor);
  expect(chunks.join('')).toBe(text);
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
