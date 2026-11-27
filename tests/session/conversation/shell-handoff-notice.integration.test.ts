import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { Model } from '../../../src/model/index.js';
import { createConversation } from '../../../src/session/conversation.js';
import type { Conversation } from '../../../src/session/types.js';
import { createLog, readFacts } from '../../../src/session/log.js';
import { directShellTasks } from '../../../src/session/shell-tasks.js';
import type { ConversationDeps } from '../../../src/session/types.js';

// shell.foregroundHandoffMs moves a model's own command; the Session must not tell the
// model that a person did it. A person's move still produces the user-control notice.
const modelRef = { provider: 'openai', model: 'fixture' };
const roots: string[] = [];
const conversations: Conversation[] = [];
afterEach(async () => {
  for (const conversation of conversations.splice(0)) await conversation.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'term2-shell-handoff-'));
  roots.push(root);
  const model: Model = {
    ref: modelRef,
    contextWindow: 100_000,
    catalogContextWindow: 100_000,
    async *stream() {
      yield { type: 'text_delta', delta: 'Done.' };
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const log = createLog(root, 'fixture');
  const conversation = createConversation({
    models: { resolve: () => model, list: () => [modelRef] },
    compaction: {
      contextWindow: 100_000,
      maxRequestInputTokens: undefined,
      settings: { enabled: false, mode: 'local', compactThreshold: 0.8, compactThresholdTokens: null },
    },
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
  type Parent = Parameters<NonNullable<ConversationDeps['shellTasks']>>[0];
  const parent = {
    turnId: 'fixture-turn' as Parent['turnId'],
    parentExecutionId: 'fixture-execution' as Parent['parentExecutionId'],
    signal: new AbortController().signal,
  };
  const start = (handoffAfterMs: number, handoffBlocked?: () => 'wait' | 'never' | undefined) => {
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => (finish = resolve));
    const handle = directShellTasks(conversation.tasks, parent).start({
      command: 'pnpm test',
      mode: 'foreground',
      handoffAfterMs,
      handoffBlocked,
      run: async () => {
        await exited;
        return 'ok';
      },
    });
    return { handle, finish };
  };
  const facts = () => readFacts(log.path);
  const notices = () =>
    facts()
      .filter((fact) => fact.type === 'background_notice_enqueued')
      .map((fact) => JSON.stringify(fact));
  return { conversation, start, facts, notices };
}

it('records an automatic handoff as such and does not claim the user moved it', async () => {
  const f = fixture();
  const { handle, finish } = f.start(100);
  expect(await handle.foreground).toEqual({ kind: 'background', handoffAfterMs: 100 });
  expect(f.facts().find((fact) => fact.type === 'task_backgrounded')).toMatchObject({ by: 'handoff' });
  expect(f.notices().some((notice) => notice.includes('The user moved'))).toBe(false);
  finish();
  await handle.settled;
  // The completion still wakes the model.
  expect(f.notices().some((notice) => notice.includes('finished'))).toBe(true);
});

it('still tells the model when a person moves the command', async () => {
  const f = fixture();
  const { handle, finish } = f.start(0);
  expect(f.conversation.tasks.moveToBackground(handle.id).ok).toBe(true);
  expect(await handle.foreground).toEqual({ kind: 'background' });
  expect(f.facts().find((fact) => fact.type === 'task_backgrounded')).not.toHaveProperty('by');
  expect(f.notices().some((notice) => notice.includes('The user moved'))).toBe(true);
  finish();
  await handle.settled;
});

it('waits while a person is being asked, then hands off once they answer', async () => {
  const f = fixture();
  let asking = true;
  let checks = 0;
  const { handle, finish } = f.start(50, () => (checks++, asking ? 'wait' : undefined));
  let moved = false;
  void handle.foreground.then(() => (moved = true));
  // Due, refused, and re-checked: the move was held while the person was asked.
  await expect.poll(() => checks, { timeout: 5000 }).toBeGreaterThanOrEqual(2);
  expect(moved).toBe(false);
  asking = false;
  expect(await handle.foreground).toMatchObject({ kind: 'background' });
  finish();
  await handle.settled;
});

it('never hands off a command whose process already exited', async () => {
  const f = fixture();
  let checks = 0;
  const { handle, finish } = f.start(50, () => (checks++, 'never'));
  await expect.poll(() => checks, { timeout: 5000 }).toBe(1);
  finish();
  expect(await handle.foreground).toEqual({ kind: 'result', value: 'ok' });
  expect(f.facts().some((fact) => fact.type === 'task_backgrounded')).toBe(false);
});
