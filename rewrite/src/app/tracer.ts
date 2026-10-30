/**
 * Tracer bullet: one request through every layer, including a real crash.
 *
 *   node rewrite/dist/rewrite/src/app/tracer.js
 *
 * Scenarios:
 *   1. An approval survives a restart: the session is dropped while waiting,
 *      reopened from its log, approved, and the turn completes.
 *   2. A crash during an idempotent tool: a child process is SIGKILLed inside
 *      `read_note`; reopening resumes from the checkpoint and completes.
 *   3. A crash during an approved, non-idempotent tool: reopening marks the
 *      turn interrupted and offers a retry instead of re-running the write.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memorySettings } from '../config/memory.js';
import { createEngine } from '../engine/loop.js';
import { scriptedModel, singleModelRegistry } from '../model/scripted.js';
import { readNote, toolRegistry, writeNote } from '../tools/notes.js';
import type { Tool } from '../tools/index.js';
import { LocalSessionStore } from '../session/local-store.js';
import { createInProcessHost } from '../host/in-process.js';
import type { Connection, Host, Principal } from '../host/index.js';
import type { WireEvent, WireInteraction } from '../protocol/index.js';
import { runHeadless } from '../clients/headless.js';

const principal: Principal = { userId: 'local', via: 'local' };

function buildHost(root: string, crashInTool?: string): Host {
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
  const engine = createEngine({ models: singleModelRegistry(scriptedModel()), tools, settings });
  const sessions = new LocalSessionStore({
    root: path.join(root, 'sessions'),
    engine,
    tools,
    settings,
    instructions: 'You are the tracer model.',
    budget: { maxModelCalls: 4, maxToolCalls: 4 },
  });
  return createInProcessHost({
    sessions,
    settings: { forSession: () => ({ ...settings, set: async () => {} }) },
    resolveWorkspace: () => path.join(root, 'workspace'),
    defaultModel: { provider: 'scripted', model: 'tracer' },
  });
}

async function until(connection: Connection, type: WireEvent['type']): Promise<WireEvent> {
  for await (const event of connection.events) if (event.type === type) return event;
  throw new Error(`connection closed before ${type}`);
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok  ${message}`);
}

const grant = { workspaceId: 'tracer', access: 'read_write' as const };

async function approvalSurvivesRestart(root: string): Promise<void> {
  console.log('1. approval survives a restart');
  const first = await buildHost(root).createSession(principal, grant);
  const submit = { type: 'submit' as const, requestId: 'req-1', text: 'write greeting: hello from the tracer' };
  const started = await first.send(submit);
  check(started.ok, 'submit is admitted');
  const opened = await until(first, 'interaction_opened');
  const duplicate = await first.send(submit);
  check(
    duplicate.ok && duplicate.turnId === (started.ok && started.turnId),
    'resending the same request id is a no-op',
  );
  first.close(); // everything in memory is discarded from here on

  const second = await buildHost(root).connect(principal, first.sessionId);
  const pending = second.snapshot.pendingInteraction;
  check(second.snapshot.status === 'awaiting_interaction', 'reopened session is still awaiting approval');
  check(
    pending?.interactionId === (opened.payload.interaction as WireInteraction).interactionId,
    'the same interaction is restored',
  );
  await second.send({
    type: 'decide',
    interactionId: pending!.interactionId,
    decisions: pending!.approvals.map((approval) => ({ callId: approval.callId, approve: true })),
  });
  const ended = await until(second, 'turn_ended');
  check(ended.payload.outcome === 'completed', 'turn completes after approval');
  check(
    fs.readFileSync(path.join(root, 'workspace', 'greeting.txt'), 'utf8') === 'hello from the tracer',
    'the tool wrote the note exactly once',
  );
  second.close();
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

async function crashDuringIdempotentToolResumes(root: string): Promise<void> {
  console.log('2. crash during an idempotent tool resumes');
  const sessionId = crashChild(root, 'read');
  const connection = await buildHost(root).connect(principal, sessionId, 0);
  const results: WireEvent[] = [];
  let ended: WireEvent | undefined;
  for await (const event of connection.events) {
    if (event.type === 'message' && (event.payload.message as { role: string }).role === 'tool') results.push(event);
    if (event.type === 'turn_ended') {
      ended = event;
      break;
    }
  }
  check(ended?.payload.outcome === 'completed', 'reopened turn resumes from its checkpoint and completes');
  check(results.length === 1, 'the tool result is committed once');
  const snapshot = (await buildHost(root).connect(principal, sessionId)).snapshot;
  check(
    snapshot.messages.at(-1)?.text.includes('hello from the tracer') === true,
    'answer uses the re-run tool output',
  );
  connection.close();
}

async function crashDuringWriteIsInterrupted(root: string): Promise<void> {
  console.log('3. crash during a non-idempotent tool is interrupted, not re-run');
  const sessionId = crashChild(root, 'write');
  const connection = await buildHost(root).connect(principal, sessionId);
  check(connection.snapshot.status === 'interrupted', 'reopened session is interrupted');
  check(connection.snapshot.canRetry, 'retry is offered');
  check(!fs.existsSync(path.join(root, 'workspace', 'other.txt')), 'the write was not replayed');
  connection.close();
}

async function child(root: string, scenario: 'read' | 'write'): Promise<void> {
  const host = buildHost(root, scenario === 'read' ? 'read_note' : 'write_note');
  const connection = await host.createSession(principal, grant);
  process.stdout.write(`session=${connection.sessionId}\n`);
  await runHeadless(connection, {
    prompt: scenario === 'read' ? 'read greeting' : 'write other: should never land',
    onApproval: 'approve_all',
    output: 'jsonl',
  });
  throw new Error('child should have been killed inside the tool');
}

async function main(): Promise<void> {
  if (process.argv[2] === 'child') return child(process.argv[3]!, process.argv[4] as 'read' | 'write');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tracer-'));
  fs.mkdirSync(path.join(root, 'workspace'));
  try {
    await approvalSurvivesRestart(root);
    await crashDuringIdempotentToolResumes(root);
    await crashDuringWriteIsInterrupted(root);
    console.log('tracer passed');
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    console.error(`session logs kept in ${root}`);
    process.exit(1);
  }
}

void main();
