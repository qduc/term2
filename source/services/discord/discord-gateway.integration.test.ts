import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { DiscordGatewayNudge } from './discord-gateway.js';

// Offline fake of the Discord Gateway protocol subset the doorbell uses. No real Discord.

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

type Frame = { op: number; d?: any; s?: number | null; t?: string | null };

async function fakeGateway(options: { ack?: boolean } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/?v=10&encoding=json`;
  const connections: Array<{ socket: WebSocket; frames: Frame[] }> = [];
  const waiters: Array<() => void> = [];
  server.on('connection', (socket) => {
    const connection = { socket, frames: [] as Frame[] };
    connections.push(connection);
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      connection.frames.push(frame);
      if (frame.op === 1 && options.ack !== false) socket.send(JSON.stringify({ op: 11 }));
      waiters.splice(0).forEach((wake) => wake());
    });
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }));
    waiters.splice(0).forEach((wake) => wake());
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        for (const client of server.clients) client.terminate();
        server.close(() => resolve());
      }),
  );
  const until = async (predicate: () => boolean, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('fake gateway wait timed out');
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  const frame = (index: number, op: number) => () => connections[index]?.frames.find((entry) => entry.op === op);
  const dispatch = (index: number, s: number, t: string, d: unknown) =>
    connections[index]!.socket.send(JSON.stringify({ op: 0, s, t, d }));
  return { url, connections, until, frame, dispatch };
}

function client(url: string) {
  const events = { nudges: 0, live: [] as boolean[], warnings: [] as string[] };
  const gateway = new DiscordGatewayNudge({
    token: 'OFFLINE_FIXTURE_TOKEN',
    channelId: '200',
    humanUserId: '100',
    onNudge: () => events.nudges++,
    onLiveChange: (live) => events.live.push(live),
    warn: (message) => events.warnings.push(message),
    url,
  });
  cleanup.push(() => gateway.stop());
  return { gateway, events };
}

it('identifies with only the non-privileged intent and nudges only for the configured human', async () => {
  // Pinning and its allowed loopback counterpart share a real transport journey.
  expect(
    () =>
      new DiscordGatewayNudge({
        token: 'OFFLINE_FIXTURE_TOKEN',
        channelId: '200',
        humanUserId: '100',
        onNudge: () => {},
        url: 'wss://gateway.example.com/?v=10&encoding=json',
      }),
  ).toThrow('Invalid Discord Gateway endpoint');
  const g = await fakeGateway();
  const { gateway, events } = client(g.url);
  gateway.start();
  await g.until(() => !!g.frame(0, 2)());
  const identify = g.frame(0, 2)()!;
  expect(identify.d.token).toBe('OFFLINE_FIXTURE_TOKEN');
  expect(identify.d.intents).toBe((1 << 9) | (1 << 10));

  g.dispatch(0, 1, 'READY', { session_id: 'session-1', resume_gateway_url: g.url });
  await g.until(() => events.nudges === 1);
  expect(gateway.live).toBe(true);
  expect(events.live).toEqual([true]);

  const message = (extra: object) => ({ id: '1', channel_id: '200', author: { id: '100' }, content: '', ...extra });
  g.dispatch(0, 2, 'MESSAGE_CREATE', message({ channel_id: '999' }));
  g.dispatch(0, 3, 'MESSAGE_CREATE', message({ author: { id: '555' } }));
  g.dispatch(0, 4, 'MESSAGE_CREATE', message({ author: { id: '100', bot: true } }));
  g.dispatch(0, 5, 'MESSAGE_CREATE', message({ webhook_id: '7' }));
  g.dispatch(0, 6, 'MESSAGE_UPDATE', message({}));
  g.dispatch(0, 7, 'MESSAGE_CREATE', message({}));
  await g.until(() => events.nudges === 2);
  // A quiet, acknowledged connection survives multiple watchdog observations.
  await g.until(() => g.connections[0]!.frames.filter((entry) => entry.op === 1).length >= 2);
  expect(gateway.live).toBe(true);
  expect(g.connections).toHaveLength(1);
  expect(events.nudges).toBe(2);
});

it('resumes after a server reconnect request and ignores a foreign resume host', async () => {
  const g = await fakeGateway();
  const { gateway, events } = client(g.url);
  gateway.start();
  await g.until(() => !!g.frame(0, 2)());
  g.dispatch(0, 41, 'READY', { session_id: 'session-1', resume_gateway_url: 'wss://evil.example.com' });
  await g.until(() => events.nudges === 1);

  g.connections[0]!.socket.send(JSON.stringify({ op: 7 }));
  g.connections[0]!.socket.pause(); // Cannot acknowledge a client close handshake.
  await g.until(() => !!g.frame(1, 6)());
  expect(g.frame(1, 2)()).toBeUndefined();
  expect(g.frame(1, 6)()!.d).toEqual({ token: 'OFFLINE_FIXTURE_TOKEN', session_id: 'session-1', seq: 41 });
  expect(events.live).toEqual([true, false]);

  g.dispatch(1, 42, 'RESUMED', {});
  await g.until(() => events.nudges === 2);
  expect(events.live).toEqual([true, false, true]);
});

it('re-identifies after a non-resumable invalid session', async () => {
  const g = await fakeGateway();
  const { gateway } = client(g.url);
  gateway.start();
  await g.until(() => !!g.frame(0, 2)());
  g.dispatch(0, 1, 'READY', { session_id: 'session-1', resume_gateway_url: g.url });
  g.connections[0]!.socket.send(JSON.stringify({ op: 9, d: false }));
  g.connections[0]!.socket.pause();
  await g.until(() => !!g.frame(1, 2)());
  expect(g.frame(1, 6)()).toBeUndefined();
});

it('reconnects a zombied connection whose heartbeats are never acknowledged', async () => {
  const g = await fakeGateway({ ack: false });
  const { gateway, events } = client(g.url);
  gateway.start();
  await g.until(() => !!g.frame(0, 2)());
  g.dispatch(0, 5, 'READY', { session_id: 'session-1', resume_gateway_url: g.url });
  await g.until(() => events.nudges === 1);
  g.connections[0]!.socket.pause(); // A real blackhole, not just a peer withholding heartbeat ACKs.
  await g.until(() => !!g.frame(1, 6)(), 5000);
  expect(g.frame(1, 6)()!.d.seq).toBe(5);
  expect(events.live).toEqual([true, false]);
}, 10_000);

it('stops on authentication failure, warns without the token and does not reconnect', async () => {
  const g = await fakeGateway();
  const { gateway, events } = client(g.url);
  gateway.start();
  await g.until(() => !!g.frame(0, 2)());
  g.connections[0]!.socket.close(4004);
  await g.until(() => events.warnings.length === 1);
  expect(events.warnings[0]).toContain('Authentication rejected');
  expect(events.warnings.join('\n')).not.toContain('OFFLINE_FIXTURE_TOKEN');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(g.connections).toHaveLength(1);
  expect(gateway.live).toBe(false);
});
