import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { nativeCataloguePath, withNativeCatalogue } from '../../src/app/native-catalogue.js';
import { nativeSessionBrowserStore } from '../../src/app/native-session-browser-store.js';
import { SessionBrowser } from '../../src/session/conversation/session-browser.js';
import type { Fact } from '../../src/session/facts.js';
import type { TranscriptJson } from '../../src/session/facade-types.js';
import { importDirectSession } from '../../src/session/import.js';

const id = 'conv_0f2e6c8a-7a51-4c1e-9d3b-5e8f4a2b6c10';
const bareId = id.slice('conv_'.length);
const at = '2026-10-04T00:00:00.000Z';
let root: string | undefined;
let browser: SessionBrowser | undefined;

afterEach(async () => {
  await browser?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

function observation(index: number, sourceMessage: TranscriptJson, role: 'system' | 'tool' = 'system'): Fact {
  return {
    type: 'transcript_message',
    message: {
      id: `observation-${index}`,
      role,
      content: [{ type: 'text', text: `canonical fallback ${index}` }],
      presentation: { sourceMessage },
    },
  };
}

async function publish(facts: readonly Fact[]) {
  root = await mkdtemp(join(tmpdir(), 'term2-native-browser-'));
  const directory = join(root, 'conversations');
  const scope = { target: 'local', root };
  const header: Fact = {
    type: 'session_started',
    id,
    workspace: root,
    workspaceIdentity: { target: 'local', root, access: 'read_write' },
    model: { provider: 'openai', model: 'fixture-model' },
    profile: { id: 'builtin:bare', version: '2.0.0', digest: 'fixture-profile' },
    appVersion: 'browser-fixture',
  };
  importDirectSession({ directory, id, entries: [header, ...facts].map((fact) => ({ at, fact })) });
  const log = join(directory, `${id}.jsonl`);
  const bytes = await readFile(log);
  const store = nativeSessionBrowserStore(directory, scope);
  browser = new SessionBrowser(() => ({ projectPath: root! }), { backend: 'canonical', store });
  return { directory, scope, log, bytes, store };
}

it('rebuilds the real catalogue and preserves validated imported kinds through search and read', async () => {
  const saved: Record<string, TranscriptJson>[] = [
    { id: 'u', sender: 'user', text: 'imported question' },
    { id: 'b', sender: 'bot', text: 'imported answer' },
    { id: 's', sender: 'system', text: 'imported notice' },
    { id: 'r', sender: 'reasoning', text: 'imported reasoning' },
    { id: 'c', sender: 'command', command: 'diagnostic', output: 'catalogue needle '.repeat(200), toolName: 'shell' },
    { id: 'a', sender: 'subagent', task: 'imported task', finalText: 'imported result' },
  ];
  const fixture = await publish(saved.map((message, index) => observation(index, message)));
  expect(withNativeCatalogue(fixture.directory, (catalogue) => catalogue.list(fixture.scope))).toHaveLength(1);
  await writeFile(nativeCataloguePath(fixture.directory), 'not a SQLite catalogue');

  const search = await browser!.search({ query: 'catalogue needle', kinds: ['tool'], maxChars: 7000 });
  expect(search).toMatchObject({
    scope: root,
    unavailable: 0,
    results: [{ sessionId: bareId, kind: 'tool', messageIndex: 4, snippet: { truncated: true } }],
  });
  expect(JSON.stringify(search)).toContain('catalogue needle');
  expect(JSON.stringify(search).length).toBeLessThanOrEqual(7000);
  expect(await browser!.read({ id: bareId, maxChars: 7000 })).toMatchObject({
    items: [
      { kind: 'user', text: 'imported question' },
      { kind: 'assistant', text: 'imported answer' },
      { kind: 'system', text: 'imported notice' },
      { kind: 'reasoning', text: 'imported reasoning' },
      { kind: 'tool', toolName: 'shell', text: `diagnostic\n${saved[4]!.output}` },
      { kind: 'subagent', text: 'imported task\nimported result' },
    ],
  });
  expect(fixture.store.loadUnscoped(bareId)).toMatchObject({ status: 'loaded', conversation: { messages: saved } });
  expect((await readFile(nativeCataloguePath(fixture.directory))).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  expect(await readFile(fixture.log)).toEqual(fixture.bytes);
});

it('falls back from malformed imported metadata and keeps genuine native tool rows without inventing commands', async () => {
  const malformed: TranscriptJson[] = [
    null,
    'not a saved message',
    [],
    { sender: 'user', text: 'missing identity' },
    { id: 'bad', sender: 'user', text: 7 },
    { id: 'bad', sender: 'bot', text: null },
    { id: 'bad', sender: 'system' },
    { id: 'bad', sender: 'reasoning', text: [] },
    { id: 'bad', sender: 'command', command: false },
    { id: 'bad', sender: 'command', command: 'wrong output', output: {} },
    { id: 'bad', sender: 'command', command: 'wrong tool name', toolName: 7 },
    { id: 'bad', sender: 'subagent', task: 7 },
    { id: 'bad', sender: 'subagent', task: 'wrong final text', finalText: [] },
    { id: 'bad', sender: 'invented', text: 'unknown kind' },
  ];
  const turnId = 'native-turn' as import('../../src/engine/index.js').TurnId;
  const executionId = 'native-execution' as import('../../src/tools/index.js').ExecutionId;
  const callId = 'native-call' as import('../../src/model/index.js').ToolCallId;
  const fixture = await publish([
    ...malformed.map((message, index) => observation(index, message)),
    observation(100, { id: 'bad-tool', sender: 'command', output: 'missing command' }, 'tool'),
    { type: 'turn_started', turnId, input: [] },
    {
      type: 'item',
      turnId,
      executionId,
      item: {
        type: 'tool_call',
        id: 'native-call-item' as import('../../src/model/index.js').ItemId,
        callId,
        toolName: 'shell',
        input: { command: 'native diagnostic' },
      },
    },
    {
      type: 'tool_started',
      turnId,
      executionId,
      callId,
      toolName: 'shell',
      input: { command: 'native diagnostic' },
    },
    { type: 'tool_finished', turnId, executionId, result: { output: 'native tool result', isError: false } },
    {
      type: 'item',
      turnId,
      executionId,
      item: {
        type: 'tool_result',
        id: 'native-result' as import('../../src/model/index.js').ItemId,
        callId,
        output: 'native tool result',
        isError: false,
      },
    },
    { type: 'turn_ended', turnId, outcome: 'completed' },
  ]);
  expect(await browser!.list({})).toMatchObject({ total: 1, unavailable: 0 });
  expect(await browser!.read({ id: bareId, limit: 30 })).toMatchObject({
    items: [
      ...malformed.map((_, index) => ({ index, kind: 'system', text: `canonical fallback ${index}` })),
      { index: malformed.length, kind: 'tool', toolName: 'shell', text: 'native diagnostic\nnative tool result' },
    ],
  });
  expect(await browser!.search({ query: 'native tool result', kinds: ['tool'] })).toMatchObject({
    unavailable: 0,
    results: [{ sessionId: bareId, messageIndex: malformed.length, kind: 'tool' }],
  });
  expect(await readFile(fixture.log)).toEqual(fixture.bytes);
});
