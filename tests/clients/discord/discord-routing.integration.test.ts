import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DiscordBridge } from '../../../src/clients/discord/discord-bridge.js';
import { ControlSocketServer } from '../../../src/clients/control-socket/control-socket.js';

it('rejects other authors and wrong-channel responses at the real bridge ingress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'term2-discord-routing-'));
  const runtime = join(root, 'runtime');
  mkdirSync(runtime, { mode: 0o700 });
  const socket = new ControlSocketServer({
    name: 'coord',
    runtimeDir: runtime,
    sessionId: () => 'test-session',
    discordInput: true,
  });
  let page: unknown[] = [];
  const requests: string[] = [];
  const warnings: string[] = [];
  const server = createServer((_request, response) => {
    requests.push(_request.url ?? '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(page));
  });
  let bridge: DiscordBridge | undefined;
  try {
    await socket.listen();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const stateDir = join(root, 'state');
    bridge = new DiscordBridge(
      { channelId: '200', humanUserId: '100', coordinator: 'coord', stateDir, maxHops: 4 },
      'fixture',
      { runtimeDir: runtime, apiBase: `http://127.0.0.1:${port}`, warn: (message) => warnings.push(message) },
    );
    bridge.open();
    const journal = () => JSON.parse(readFileSync(join(stateDir, 'journal.json'), 'utf8'));
    await bridge.tick();
    page = [
      { id: '1', channel_id: '200', author: { id: '999' }, content: 'other user' },
      { id: '2', channel_id: '200', author: { id: '100', bot: true }, content: 'bot echo' },
      { id: '3', channel_id: '200', author: { id: '100' }, content: 'authorized control' },
    ];
    await bridge.tick();
    expect(journal().cursor).toBe('3');
    expect(journal().jobs.map((job: { id: string }) => job.id)).toEqual(['discord_3']);
    page = [{ id: '4', channel_id: '201', author: { id: '100' }, content: 'wrong channel' }];
    await bridge.tick();
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain('after=3');
    expect(warnings.some((warning) => warning.includes('Discord ingress unavailable or rejected'))).toBe(true);
    expect(journal().cursor).toBe('3');
    expect(journal().jobs.map((job: { id: string }) => job.id)).toEqual(['discord_3']);
  } finally {
    bridge?.close();
    await socket.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
