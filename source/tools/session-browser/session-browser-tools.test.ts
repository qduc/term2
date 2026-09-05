import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConversationLogWriter } from '../../services/logging/conversation-log-writer.js';
import { setConversationsDirForTest } from '../../services/conversation/conversation-persistence.js';
import { SessionBrowser } from '../../services/conversation/session-browser.js';
import { createSessionBrowserToolDefinitions } from './session-browser-tools.js';

let dir = '';
const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {}, getCorrelationId: () => undefined } as any;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-session-browser-tools-'));
  setConversationsDirForTest(dir);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  setConversationsDirForTest(null);
});

const browser = {
  list: () => ({ sessions: [], total: 0, omitted: 0, unavailable: 0, charsUsed: 72 }),
  search: () => ({ results: [], total: 0, omitted: 0, unavailable: 0, skippedMessageCount: 0, charsUsed: 92 }),
  read: () => ({
    session: { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    items: [],
    total: 0,
    omitted: 0,
    skippedMessageCount: 0,
    charsUsed: 140,
  }),
} as any;

it('exposes read-only browser tools with strict bounded parameter schemas', async () => {
  const tools = createSessionBrowserToolDefinitions(browser);
  expect(tools.map((tool) => tool.name)).toEqual(['session_list', 'session_search', 'session_read']);
  expect(tools.every((tool) => tool.preserveSerializedOutput)).toBe(true);
  for (const tool of tools) expect(tool.needsApproval({} as never)).toBe(false);
  expect(tools[0]!.parameters.safeParse({ maxChars: 511 }).success).toBe(false);
  expect(tools[1]!.parameters.safeParse({ query: '   ' }).success).toBe(false);
  expect(tools[2]!.parameters.safeParse({ id: '../escape' }).success).toBe(false);
  expect(JSON.parse((await tools[0]!.execute({})) as string)).toMatchObject({ sessions: [] });

  // Descriptions are product behavior: pin the `total`/`omitted` semantics and
  // the live-session demotion rule so a cleanup cannot silently drop them.
  expect(tools[0]!.description).toContain('`total` is the number of browsable sessions in scope');
  expect(tools[1]!.description).toContain('`total` is the number of ranked matches before `limit` is applied');
  expect(tools[1]!.description).toContain('Matches from the currently active session sort last');
  expect(tools[2]!.description).toContain('`from: "end"` starts at the last `limit` projected records');
  expect(tools[2]!.description).toContain('without `from: "end"` the read starts at the first record');
  expect(tools[2]!.description).toContain('`nextCursor` is returned only while forward content remains');
  expect(tools[2]!.description).toContain('`total - omitted` records are represented here');
  // Search hits carry the session's last-write time, not per-message times.
  expect(tools[1]!.description).toContain("`updatedAt` is the session's last-write timestamp");
  expect(tools[2]!.parameters.safeParse({ id: 'a', from: 'end' }).success).toBe(true);
  expect(tools[2]!.parameters.safeParse({ id: 'a', from: 'start' }).success).toBe(false);
  expect(tools[2]!.parameters.safeParse({ id: 'a', from: 'end', cursor: 'c1' }).success).toBe(false);
});

it('executes session_read at the tool boundary with the pinned serialized envelope field set', async () => {
  const id = 'envelope-session';
  const writer = createConversationLogWriter({ sessionId: id, dir, logger });
  writer.init({ id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: '/project' });
  for (let i = 0; i < 3; i++) {
    writer.append({ type: 'user_message', message: { id: `u${i}`, sender: 'user', text: `record ${i}` } });
    writer.append({
      type: 'assistant_turn',
      turn: { items: [{ type: 'assistant_text', text: `answer ${i}` }] },
      state: { previousResponseId: null },
    });
  }
  void writer.close();
  const read = createSessionBrowserToolDefinitions(new SessionBrowser(() => ({ projectPath: '/project' })))[2]!;

  // Consumed tail page: nextCursor is absent from the envelope, not null, and
  // charsUsed equals the serialized length the model actually receives.
  const rawTail = (await read.execute({ id, from: 'end', limit: 2 })) as string;
  const tail = JSON.parse(rawTail);
  expect(Object.keys(tail).sort()).toEqual([
    'charsUsed',
    'items',
    'omitted',
    'scope',
    'session',
    'skippedMessageCount',
    'total',
  ]);
  expect(tail.total).toBe(6);
  expect(tail.omitted).toBe(4);
  expect(tail.charsUsed).toBe(rawTail.length);

  // Forward page within budget: nextCursor is a short opaque handle.
  const rawForward = (await read.execute({ id, limit: 1, maxChars: 512 })) as string;
  const forward = JSON.parse(rawForward);
  expect(Object.keys(forward)).toContain('nextCursor');
  expect(forward.nextCursor).toMatch(/^c[0-9a-z]+$/);
  expect(forward.total).toBe(6);
  expect(forward.omitted).toBe(5);
  expect(rawForward.length).toBeLessThanOrEqual(512);
});
