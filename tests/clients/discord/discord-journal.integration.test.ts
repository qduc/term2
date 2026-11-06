import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { ControlSocketServer } from '../../../src/clients/control-socket/control-socket.js';
import { DiscordBridge } from '../../../src/clients/discord/discord-bridge.js';
import { sendDiscord, type DiscordBinding } from '../../../src/clients/discord/discord-outbound.js';

interface JournalSnapshot {
  outbox: Array<{
    id: string;
    content: string;
    state: string;
    discordMessageId?: string;
  }>;
  proactive: Array<{ binding: DiscordBinding; requestId: string; outputs: string[] }>;
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// The bridge, discovery/RPC, identity advertisement and journal are real. Only
// Discord's external HTTP API is replaced; no session/model inference is needed.
async function fixture() {
  const root = fs.mkdtempSync(
    path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'discord-journal-'),
  );
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  const coordinator = new ControlSocketServer({
    name: 'coord',
    runtimeDir: runtime,
    sessionId: () => 'offline-journal-coordinator',
    discordInput: true,
  });
  cleanup.push(() => coordinator.close());
  await coordinator.listen();
  const config = {
    channelId: '200',
    humanUserId: '100',
    coordinator: 'coord',
    stateDir: path.join(root, 'state'),
    maxHops: 4,
  };
  const journalFile = path.join(config.stateDir, 'journal.json');
  const readJournal = (): JournalSnapshot => JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const posts: Array<{ nonce: string; content: string; messageId: string; durableState: string | undefined }> = [];
  const unexpected: string[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.headers.authorization !== 'Bot OFFLINE_JOURNAL_TOKEN') unexpected.push('authorization');
    if (request.method === 'GET' && request.url?.startsWith('/channels/200/messages?')) {
      response.end('[]');
      return;
    }
    if (request.method === 'POST' && request.url === '/channels/200/messages') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const post = JSON.parse(body) as { nonce: string; content: string };
      const messageId = String(1000 + posts.length);
      posts.push({
        ...post,
        messageId,
        durableState: readJournal().outbox.find((output) => output.id === post.nonce)?.state,
      });
      response.end(JSON.stringify({ id: messageId }));
      return;
    }
    unexpected.push(`${request.method} ${request.url}`);
    response.writeHead(500).end('{}');
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const apiBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let bridge: DiscordBridge | undefined;
  cleanup.push(() => bridge?.close());
  const restart = async (snapshot?: JournalSnapshot) => {
    bridge?.close();
    if (snapshot) fs.writeFileSync(journalFile, JSON.stringify(snapshot), { mode: 0o600 });
    bridge = new DiscordBridge(config, 'OFFLINE_JOURNAL_TOKEN', { runtimeDir: runtime, apiBase });
    bridge.open();
    await bridge.listenOutbound();
  };
  await restart();
  return {
    readJournal,
    journalFile,
    posts,
    unexpected,
    restart,
    tick: () => bridge!.tick(),
    send: (requestId: string, text = 'x') =>
      sendDiscord(runtime, coordinator.binding, { action: 'send', requestId, text }),
    status: (requestId: string) => sendDiscord(runtime, coordinator.binding, { action: 'status', requestId }),
  };
}

it('retains sent idempotency evidence beyond 512 lifetime notifications and restart', async () => {
  const f = await fixture();
  for (let index = 0; index < 514; index++) {
    expect(await f.send(`settled_${index}`, `notice ${index}`)).toMatchObject({ delivery: 'queued' });
    await f.tick();
  }
  expect(f.posts).toHaveLength(514);
  expect(f.posts.every((post) => post.durableState === 'sending')).toBe(true);
  const snapshot = f.readJournal();
  expect(snapshot.proactive).toHaveLength(514);
  expect(snapshot.outbox).toHaveLength(514);
  expect(snapshot.outbox.map((output) => output.discordMessageId)).toEqual(f.posts.map((post) => post.messageId));

  // Exercise ordinary settled-output trimming beside retained explicit sends.
  // These old automatic outputs have no explicit-send index and must not erase it.
  for (let index = 0; index < 513; index++) {
    snapshot.outbox.push({ id: `a${index.toString(16).padStart(23, '0')}`, content: 'legacy output', state: 'sent' });
  }
  await f.restart(snapshot);
  await f.tick();
  expect(f.readJournal().outbox.filter((output) => output.content === 'legacy output')).toHaveLength(512);
  expect(f.readJournal().outbox.filter((output) => output.content.startsWith('[coord] notice '))).toHaveLength(514);
  await f.restart();

  for (const index of [0, 513]) {
    const expected = {
      delivery: 'sent',
      chunks: { queued: 0, sent: 1, uncertain: 0 },
      messageIds: [f.posts[index]!.messageId],
    };
    expect(await f.status(`settled_${index}`)).toMatchObject(expected);
    expect(await f.send(`settled_${index}`, `notice ${index}`)).toMatchObject(expected);
  }
  expect(await f.send('settled_0', 'changed notice')).toMatchObject({
    delivery: 'rejected',
    reason: 'request_id_conflict',
  });
  await f.tick();
  expect(f.posts).toHaveLength(514);
  expect(f.unexpected).toEqual([]);
}, 60_000);

it('admits exactly at the retained-journal byte budget and preserves reconciliation and accepted delivery when full', async () => {
  const f = await fixture();
  const bytes = (snapshot: JournalSnapshot) => Buffer.byteLength(JSON.stringify(snapshot));
  expect(await f.send('a')).toMatchObject({ delivery: 'queued' });
  const snapshot = f.readJournal();
  // Measure the real serialized footprint instead of duplicating production
  // hashing/chunking. Neither admission has produced an external effect yet.
  expect(await f.send('b')).toMatchObject({ delivery: 'queued' });
  const growth = bytes(f.readJournal()) - bytes(snapshot);
  const budget = 16 * 1024 * 1024;
  const target = budget - growth;
  const padding = { id: 'b'.repeat(24), content: 'é'.repeat(850), state: 'queued' };
  const rowBytes = Buffer.byteLength(JSON.stringify(padding)) + 1;
  const count = Math.floor((target - bytes(snapshot)) / rowBytes) - 1;
  for (let index = 0; index < count; index++) {
    snapshot.outbox.push({ ...padding, id: `b${index.toString(16).padStart(23, '0')}` });
  }
  const tail = { id: 'c'.repeat(24), content: '', state: 'queued' };
  snapshot.outbox.push(tail);
  const remaining = target - bytes(snapshot);
  tail.content = 'é'.repeat(Math.floor(remaining / 2)) + 'x'.repeat(remaining % 2);
  expect(bytes(snapshot)).toBe(target);
  // Withheld legacy queued output remains operator-owned and counts toward the
  // budget. Restart must load it unchanged without automatically posting it.
  await f.restart(snapshot);
  expect(fs.statSync(f.journalFile).size).toBe(target);
  expect(await f.send('b')).toMatchObject({ delivery: 'queued' });
  expect(fs.statSync(f.journalFile).size).toBe(budget);
  const full = fs.readFileSync(f.journalFile, 'utf8');
  expect(await f.send('c')).toMatchObject({
    delivery: 'rejected',
    reason: 'capacity',
    capacity: { kind: 'journal_bytes', used: budget + growth, limit: budget },
  });
  expect(fs.readFileSync(f.journalFile, 'utf8')).toBe(full);
  expect(await f.status('c')).toMatchObject({ delivery: 'missing' });
  for (const requestId of ['a', 'b']) {
    expect(await f.status(requestId)).toMatchObject({ delivery: 'queued' });
    expect(await f.send(requestId)).toMatchObject({ delivery: 'queued' });
  }
  expect(f.readJournal().proactive.map((entry) => entry.requestId)).toEqual(['a', 'b']);
  await f.tick();
  await f.tick();
  expect(f.posts.map((post) => post.content)).toEqual(['[coord] x', '[coord] x']);
  expect(f.posts.every((post) => post.durableState === 'sending')).toBe(true);
  expect(f.readJournal().outbox.filter((output) => output.state === 'queued')).toHaveLength(count + 1);
  await f.restart();
  for (const [index, requestId] of ['a', 'b'].entries()) {
    expect(await f.send(requestId)).toMatchObject({ delivery: 'sent', messageIds: [f.posts[index]!.messageId] });
  }
  await f.tick();
  expect(f.posts).toHaveLength(2);
  expect(f.unexpected).toEqual([]);
}, 30_000);
