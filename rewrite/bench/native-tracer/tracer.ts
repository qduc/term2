/** Explicit native-engine fixture; none of these checks prove C2 persistence. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memorySettings } from '../../src/config/memory.js';
import { createEngine } from '../../src/engine/loop.js';
import { scriptedModel } from '../../src/model/scripted.js';
import { readNote, toolRegistry, writeNote } from '../../src/tools/notes.js';
import type { Tool } from '../../src/tools/index.js';
import { NativeTracerStore } from './local-store.js';
import type { TracerInteractionId, TracerSession, TracerSessionId, TracerSessionUpdate } from './session-types.js';

const workspace = (root: string) => ({ root, access: 'read_write' as const, target: 'local' as const });
const modelRef = { provider: 'scripted', model: 'tracer' };

function buildStore(root: string, crashInTool?: string) {
  let providerCalls = 0;
  const baseModel = scriptedModel();
  const model = {
    ...baseModel,
    async *stream(...args: Parameters<typeof baseModel.stream>) {
      providerCalls += 1;
      yield* baseModel.stream(...args);
    },
  };
  const crashing = (tool: Tool<any>): Tool<any> =>
    tool.spec.name === crashInTool
      ? {
          ...tool,
          execute: () => {
            process.kill(process.pid, 'SIGKILL');
            return new Promise(() => {});
          },
        }
      : tool;
  const tools = toolRegistry([readNote, writeNote].map(crashing));
  const settings = memorySettings();
  const store = new NativeTracerStore({
    root: path.join(root, 'sessions'),
    engine: createEngine({ models: { resolve: () => model, list: () => [model.ref] }, tools, settings }),
    tools,
    settings,
    instructions: 'You are the tracer model.',
    budget: { maxModelCalls: 4, maxToolCalls: 4 },
  });
  return { store, providerCalls: () => providerCalls };
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok  ${message}`);
}

async function waitForFact(session: TracerSession, type: string): Promise<TracerSessionUpdate> {
  return new Promise((resolve) => {
    const stop = session.subscribe(session.state().lastSeq, (update) => {
      if (update.kind === 'fact' && update.entry.fact.type === type) {
        stop();
        resolve(update);
      }
    });
  });
}

async function approvalRecovery(root: string): Promise<void> {
  console.log('1. approval restart is interrupted and stale decisions are rejected');
  const { store } = buildStore(root);
  const first = await store.create(workspace(path.join(root, 'workspace')), modelRef);
  const openedPromise = waitForFact(first, 'interaction_opened');
  const started = await first.submit('req-1' as never, [
    {
      type: 'user_message',
      id: 'm-1' as never,
      content: [{ type: 'text', text: 'write greeting: hello from the tracer' }],
    },
  ]);
  check(started.kind === 'started', 'submit is admitted');
  const opened = await openedPromise;
  check(opened.kind === 'fact' && opened.entry.fact.type === 'interaction_opened', 'approval becomes pending');
  check(!fs.existsSync(path.join(root, 'workspace', 'greeting.txt')), 'write has no effect before decision');
  const staleId = (
    opened.entry.fact.type === 'interaction_opened' ? opened.entry.fact.interactionId : ''
  ) as TracerInteractionId;
  await first.close();
  const { store: reopenedStore, providerCalls } = buildStore(root);
  const second = await reopenedStore.open(first.id);
  check(second.state().status === 'interrupted', 'awaiting interaction reopens as interrupted');
  check(second.state().pendingInteraction === null, 'recovery removes the actionable prompt');
  let staleRejected = false;
  try {
    await second.decide(staleId, []);
  } catch {
    staleRejected = true;
  }
  check(staleRejected, 'a pre-restart decision is stale');
  check(providerCalls() === 0, 'opening does not call the provider');
  await second.close();
  const logPath = path.join(root, 'sessions', `${first.id}.jsonl`);
  const reconciledBytes = fs.readFileSync(logPath);
  const stable = await reopenedStore.open(first.id);
  check(stable.state().status === 'interrupted', 'reopen after reconciliation remains interrupted');
  check(fs.readFileSync(logPath).equals(reconciledBytes), 'reopen after reconciliation appends no duplicate facts');
  await stable.close();
}

function crashChild(root: string, scenario: 'read' | 'write'): string {
  const child = spawnSync(process.execPath, [process.argv[1]!, 'child', root, scenario], { encoding: 'utf8' });
  check(
    child.signal === 'SIGKILL',
    `child process was killed inside ${scenario === 'read' ? 'read_note' : 'write_note'}`,
  );
  const sessionId = /session=(\S+)/.exec(child.stdout)?.[1];
  if (!sessionId) throw new Error(`child did not report a session: ${child.stdout}${child.stderr}`);
  return sessionId;
}

async function crashDuringToolDoesNotResume(root: string, scenario: 'read' | 'write'): Promise<void> {
  console.log(`2. crash during ${scenario}_note never resumes the native checkpoint`);
  const sessionId = crashChild(root, scenario);
  const { store, providerCalls } = buildStore(root);
  const session = await store.open(sessionId as TracerSessionId);
  check(session.state().status === 'interrupted', 'reopened session is interrupted');
  check(providerCalls() === 0, 'reopen issues no provider calls');
  check(!fs.existsSync(path.join(root, 'workspace', 'other.txt')), 'the write was not replayed');
  await session.close();
}

async function child(root: string, scenario: 'read' | 'write'): Promise<void> {
  const { store } = buildStore(root, scenario === 'read' ? 'read_note' : 'write_note');
  const session = await store.create(workspace(path.join(root, 'workspace')), modelRef);
  fs.writeSync(1, `session=${session.id}\n`);
  const pending = scenario === 'write' ? waitForFact(session, 'interaction_opened') : null;
  await session.submit('child-request' as never, [
    {
      type: 'user_message',
      id: 'm-child' as never,
      content: [{ type: 'text', text: scenario === 'read' ? 'read greeting' : 'write other: should never land' }],
    },
  ]);
  if (pending) {
    const update = await pending;
    if (update.kind !== 'fact' || update.entry.fact.type !== 'interaction_opened')
      throw new Error('write approval did not open');
    await session.decide(
      update.entry.fact.interactionId,
      update.entry.fact.approvals.map((approval) => ({
        callId: approval.callId,
        decision: { kind: 'approve' as const },
      })),
    );
  }
  throw new Error('child should have been killed inside the tool');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'child') return child(process.argv[3]!, process.argv[4] as 'read' | 'write');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-native-tracer-'));
  fs.mkdirSync(path.join(root, 'workspace'));
  try {
    await approvalRecovery(root);
    await crashDuringToolDoesNotResume(root, 'read');
    await crashDuringToolDoesNotResume(root, 'write');
    console.log('native tracer fixture passed');
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(`fixture logs kept in ${root}`);
    process.exit(1);
  }
}

void main();
