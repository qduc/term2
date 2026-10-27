import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { ControlSocketServer } from '../control-socket/control-socket.js';
import { sendDiscord } from './discord-outbound.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Unlike the imported-runner checks, these exercise signal registration in the
// shipped entry point. Build dist with the current source before running this tier.
it.each(
  (['SIGTERM', 'SIGINT'] as const).flatMap((signal) =>
    (['get-release', 'get-timeout', 'post-ack', 'post-timeout'] as const).map((boundary) => ({ signal, boundary })),
  ),
)(
  'built Discord CLI drains $boundary on $signal before releasing ownership and exiting',
  async ({ signal, boundary }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-cli-'));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(runtime, { mode: 0o700 });
    const coordinator = new ControlSocketServer({
      name: 'coord',
      runtimeDir: runtime,
      sessionId: () => 'offline-cli-coordinator',
      discordInput: true,
    });
    await coordinator.listen();
    cleanup.push(() => coordinator.close());
    const stateDir = path.join(root, 'durable');
    const configFile = path.join(root, 'discord.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({ channelId: '200', humanUserId: '100', coordinator: 'coord', stateDir }),
      { mode: 0o600 },
    );
    const owner = path.join(stateDir, 'owner.json');
    const journalFile = path.join(stateDir, 'journal.json');
    const journal = () => JSON.parse(fs.readFileSync(journalFile, 'utf8'));
    let hold = true;
    let gets = 0;
    const posts: Array<{ nonce: string; content: string }> = [];
    let held: ServerResponse | undefined;
    const server = createServer(async (req, res) => {
      expect(req.headers.authorization).toBe('Bot OFFLINE_CLI_TOKEN');
      if (req.method === 'GET') {
        gets++;
        if (boundary.startsWith('get-') && hold) {
          held = res;
          return;
        }
        const after = new URL(req.url!, 'http://127.0.0.1').searchParams.has('after');
        res.end(
          after ? '[]' : JSON.stringify([{ id: '10', channel_id: '200', author: { id: '100' }, content: 'watermark' }]),
        );
      } else {
        expect(req.method).toBe('POST');
        let body = '';
        for await (const chunk of req) body += String(chunk);
        const post = JSON.parse(body);
        expect(journal().outbox.find((row: { id: string }) => row.id === post.nonce).state).toBe('sending');
        posts.push(post); // External effect accepted, acknowledgement deliberately withheld.
        held = res;
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as { port: number }).port;
    const preload = path.join(root, 'offline.mjs');
    fs.writeFileSync(
      preload,
      `
      import https from 'node:https';
      import {syncBuiltinESMExports} from 'node:module';
      https.request = () => { throw new Error('Unexpected HTTPS egress'); };
      syncBuiltinESMExports();
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => {
        if (!String(url).startsWith('https://discord.com/api/v10/')) throw new Error('Unexpected REST egress');
        return nativeFetch('http://127.0.0.1:${port}' + String(url).slice('https://discord.com/api/v10'.length), options);
      };
    `,
      { mode: 0o600 },
    );
    const env = {
      PATH: process.env.PATH,
      HOME: root,
      NODE_ENV: 'test',
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_RUNTIME_DIR: runtime,
      TMPDIR: root,
      TERM2_DISCORD_BOT_TOKEN: 'OFFLINE_CLI_TOKEN',
      TERM2_DISCORD_GATEWAY: 'off',
    };
    function launch() {
      const child = spawn(process.execPath, ['--import', preload, 'dist/cli.js', 'discord', configFile], {
        cwd: process.cwd(),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      const exited = once(child, 'exit');
      cleanup.push(async () => {
        // Only ever signal children created by this fixture, never discovered PIDs.
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
      });
      return { child, exited, output: () => output };
    }
    const artifacts = () => fs.readdirSync(path.join(runtime, 'term2-discord')).sort();
    const first = launch();
    await expect.poll(() => gets, { timeout: 5000 }).toBeGreaterThan(0);
    if (boundary.startsWith('post-')) {
      await expect.poll(() => journal().cursor, { timeout: 5000 }).toBe('10');
      expect(
        await sendDiscord(runtime, coordinator.binding, {
          action: 'send',
          requestId: 'held-post',
          text: 'one offline notification',
        }),
      ).toMatchObject({ delivery: 'queued' });
      await expect.poll(() => posts.length, { timeout: 5000 }).toBe(1);
      expect(journal().outbox.map((row: { state: string }) => row.state)).toEqual(['sending']);
    } else {
      await expect.poll(() => held, { timeout: 5000 }).toBeDefined();
    }
    expect(fs.existsSync(owner)).toBe(true);
    expect(artifacts()).toHaveLength(2);
    first.child.kill(signal);
    // A force-exiting global listener used to beat the runner's finally here.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(first.child.exitCode, first.output()).toBeNull();
    expect(first.child.signalCode).toBeNull();
    expect(fs.existsSync(owner)).toBe(true);
    // Repeated/opposite signals must not cut cleanup short or replace the first code.
    first.child.kill(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
    hold = false;
    if (boundary === 'get-release')
      held!.end(JSON.stringify([{ id: '10', channel_id: '200', author: { id: '100' }, content: 'watermark' }]));
    if (boundary === 'post-ack') held!.end(JSON.stringify({ id: '900' }));
    const code = signal === 'SIGINT' ? 130 : 143;
    await expect.poll(() => first.child.exitCode, { timeout: 15_000 }).toBe(code);
    expect(await first.exited).toEqual([code, null]);
    expect(fs.existsSync(owner)).toBe(false);
    expect(artifacts()).toEqual([]);
    const states = boundary.startsWith('post-') ? [boundary === 'post-ack' ? 'sent' : 'uncertain'] : [];
    expect(journal().outbox.map((row: { state: string }) => row.state)).toEqual(states);
    expect(journal().cursor).toBe(boundary === 'get-timeout' ? '' : '10');
    expect(journal().jobs).toEqual([]);
    expect(posts).toHaveLength(boundary.startsWith('post-') ? 1 : 0);
    console.log(
      JSON.stringify({
        signal,
        boundary,
        pid: first.child.pid,
        exit: [code, null],
        owner: false,
        artifacts: [],
        cursor: journal().cursor,
        states,
        gets,
        posts: posts.length,
      }),
    );

    // Restart against exactly the same journal and live identity: acknowledged
    // and ambiguous effects must both remain non-retryable, even on identical RPC replay.
    server.closeAllConnections();
    const before = gets;
    const second = launch();
    await expect.poll(() => gets, { timeout: 5000 }).toBeGreaterThan(before + 1);
    if (boundary.startsWith('post-')) {
      expect(
        await sendDiscord(runtime, coordinator.binding, {
          action: 'send',
          requestId: 'held-post',
          text: 'one offline notification',
        }),
      ).toMatchObject({ delivery: states[0] });
      expect(journal().outbox.map((row: { state: string }) => row.state)).toEqual(states);
      expect(posts).toHaveLength(1);
    }
    second.child.kill(signal);
    await expect.poll(() => second.child.exitCode, { timeout: 5000 }).toBe(code);
    expect(await second.exited).toEqual([code, null]);
    expect(fs.existsSync(owner)).toBe(false);
    expect(artifacts()).toEqual([]);
    expect(posts).toHaveLength(boundary.startsWith('post-') ? 1 : 0);
    for (const run of [first, second]) {
      expect(run.output()).not.toContain('OFFLINE_CLI_TOKEN');
      expect(run.output()).not.toContain('Token usage:');
    }
  },
  30_000,
);
