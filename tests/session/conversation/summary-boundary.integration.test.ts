import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Item, ItemId, Model, ModelRequest, ToolCallId } from '../../../src/model/index.js';
import { createConversation, openConversation } from '../../../src/session/conversation.js';
import type { Conversation, Turn } from '../../../src/session/types.js';
import { createLog, openLog, readFacts } from '../../../src/session/log.js';
import { replay } from '../../../src/session/replay.js';

const modelRef = { provider: 'openai', model: 'fixture' };
const settings = { model: modelRef, instructions: 'Keep accepted context.', tools: [] };
const roots: string[] = [];
const conversations: Conversation[] = [];
afterEach(async () => {
  for (const conversation of conversations.splice(0)) await conversation.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function user(id: string): Item {
  return { type: 'user_message', id: id as ItemId, content: [{ type: 'text', text: id }] };
}

const original: Item[] = [
  user('original-user-constraint'),
  {
    type: 'tool_call',
    id: 'completed-call' as ItemId,
    callId: 'evidence-call' as ToolCallId,
    toolName: 'read_evidence',
    input: {},
  },
  {
    type: 'tool_result',
    id: 'completed-result' as ItemId,
    callId: 'evidence-call' as ToolCallId,
    output: 'Previously completed evidence; do not repeat the work.',
    isError: false,
  },
];

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'term2-summary-boundary-'));
  roots.push(root);
  const requests: ModelRequest[] = [];
  let failSummary = false;
  const model: Model = {
    ref: modelRef,
    contextWindow: 100_000,
    catalogContextWindow: 100_000,
    async *stream(request) {
      requests.push(structuredClone(request));
      const summary = JSON.stringify(request.input).includes('[Host context-compaction request]');
      if (summary && failSummary) throw new Error('Fixture summary failed');
      yield {
        type: 'text_delta',
        delta: summary ? 'A short checkpoint.' : requests.length === 1 ? 'accepted context '.repeat(1000) : 'Done.',
      };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const deps = {
    models: { resolve: () => model, list: () => [modelRef] },
    compaction: {
      contextWindow: 100_000,
      settings: { enabled: false, mode: 'local' as const, compactThreshold: 0.8, compactThresholdTokens: null },
    },
  };
  const log = createLog(root, 'fixture');
  const conversation = createConversation({
    ...deps,
    log,
    meta: {
      id: 'fixture',
      workspace: root,
      model: modelRef,
      profile: { id: 'fixture', version: '1', digest: 'fixture' },
      appVersion: 'test',
    },
  });
  conversations.push(conversation);
  return {
    conversation,
    requests,
    log,
    failSummary: () => (failSummary = true),
    allowSummary: () => (failSummary = false),
    async reopen() {
      await conversation.close();
      const reopened = openConversation({ ...deps, log: openLog(log.path), facts: readFacts(log.path) });
      conversations.push(reopened);
      return reopened;
    },
  };
}

async function drain(turn: Turn) {
  let outcome: string | undefined;
  for await (const event of turn.events) if (event.type === 'turn_ended') outcome = event.result.kind;
  expect(outcome).toBe('completed');
}

it.each(['compact_turn:budget-notice:1', 'compact_turn:normal-stop:1', 'compact_turn:notice:1', 'ordinary-notice'])(
  'keeps additive summary %s and prior evidence in live and reopened requests',
  async (id) => {
    const f = fixture();
    const notice: Item = {
      type: 'summary',
      id: id as ItemId,
      text: 'Continue with the accepted evidence.',
      replaces: [],
    };
    await drain(f.conversation.run({ ...settings, input: [...original, notice] }));
    expect(f.requests[0]!.input).toEqual([...original, notice]);
    const reopened = await f.reopen();
    const followup = user('followup');
    await drain(reopened.run({ ...settings, input: [followup] }));
    expect(f.requests.at(-1)!.input.slice(0, original.length + 1)).toEqual([...original, notice]);
    expect(f.requests.at(-1)!.input.at(-1)).toEqual(followup);
  },
);

it.each<Item>([
  {
    type: 'summary',
    id: 'replacement-without-prefix' as ItemId,
    text: 'Checkpoint',
    replaces: original.map((item) => item.id),
  },
  {
    type: 'provider_opaque',
    id: 'native-checkpoint' as ItemId,
    provider: 'openai',
    item: { type: 'compaction', encrypted_content: 'fixture-only' },
  },
])('keeps an explicit $type replacement boundary after reopen', async (checkpoint) => {
  const f = fixture();
  const tail = user('retained-tail');
  await drain(f.conversation.run({ ...settings, input: [...original, checkpoint, tail] }));
  expect(f.requests[0]!.input).toEqual([checkpoint, tail]);
  const reopened = await f.reopen();
  await drain(reopened.run({ ...settings, input: [user('followup')] }));
  expect(f.requests.at(-1)!.input.slice(0, 2)).toEqual([checkpoint, tail]);
  expect(f.requests.at(-1)!.input.some((item) => item.id === original[0]!.id)).toBe(false);
});

it('lets accepted history_replaced own an empty-replaces checkpoint', async () => {
  const f = fixture();
  await drain(f.conversation.run({ ...settings, input: original }));
  const checkpoint: Item = { type: 'summary', id: 'compact_empty' as ItemId, text: 'Checkpoint', replaces: [] };
  const replacement = [checkpoint, user('retained-tail')];
  f.log.append([{ type: 'history_replaced', reason: 'compaction', history: replacement }]);
  expect(replay(readFacts(f.log.path)).history).toEqual(replacement);
  const reopened = await f.reopen();
  await drain(reopened.run({ ...settings, input: [user('followup')] }));
  expect(f.requests.at(-1)!.input).toEqual([...replacement, user('followup')]);
});

it('keeps failed local compaction transactional and replays a successful checkpoint', async () => {
  const f = fixture();
  for (const id of ['first', 'second', 'third']) await drain(f.conversation.run({ ...settings, input: [user(id)] }));
  const before = f.conversation.acceptedHistory();
  const compact = (commandId: string) =>
    f.conversation.command({ commandId, operation: { kind: 'compact' } }, settings, async () => {});
  f.failSummary();
  const failed = await compact('failed-compaction');
  expect(failed.result).toMatchObject({
    kind: 'finished',
    receipt: { outcome: { kind: 'rejected', code: 'failed', message: 'Fixture summary failed' } },
  });
  expect(f.conversation.acceptedHistory()).toEqual(before);
  expect(readFacts(f.log.path).some((fact) => fact.type === 'history_replaced')).toBe(false);
  expect(readFacts(f.log.path).some((fact) => fact.type === 'compaction_failed')).toBe(true);
  f.allowSummary();
  const result = await compact('successful-compaction');
  expect(result.result).toMatchObject({ kind: 'finished', receipt: { outcome: { kind: 'compacted' } } });
  const replacement = f.conversation.acceptedHistory();
  expect(replacement[0]).toMatchObject({ type: 'summary' });
  expect(replacement.filter((item) => item.type === 'user_message')).toEqual(['first', 'second', 'third'].map(user));
  expect(replacement.some((item) => item.type === 'assistant_message' && item.id === before[1]!.id)).toBe(false);
  const reopened = await f.reopen();
  await drain(reopened.run({ ...settings, input: [user('after-compaction')] }));
  expect(f.requests.at(-1)!.input).toEqual([...replacement, user('after-compaction')]);
});
