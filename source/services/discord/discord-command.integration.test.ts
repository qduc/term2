import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocketServer, type WebSocket } from 'ws';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it.each(['push', 'off', 'blackhole-recovery', 'blackhole-stop'])(
  'runs the real Discord runner offline with Gateway %s and releases ownership on SIGTERM',
  async (mode) => {
    const root = fs.mkdtempSync(
      path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'discord-runner-'),
    );
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(runtime, { mode: 0o700 });
    const stateDir = path.join(root, 'state');
    const configFile = path.join(root, 'discord.json');
    fs.writeFileSync(
      configFile,
      JSON.stringify({ channelId: '200', humanUserId: '100', coordinator: 'coord', stateDir }),
    );
    const responses: ServerResponse[] = [];
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBe('Bot OFFLINE_RUNNER_TOKEN');
      expect(req.method).toBe('GET');
      responses.push(res);
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
    const restPort = (server.address() as { port: number }).port;
    const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(gateway, 'listening');
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          for (const socket of gateway.clients) socket.terminate();
          gateway.close(() => resolve());
        }),
    );
    const gatewayPort = (gateway.address() as { port: number }).port;
    let socket: WebSocket | undefined;
    let identified = false;
    let connections = 0;
    gateway.on('connection', (client) => {
      connections++;
      socket = client;
      client.on('message', (data) => {
        const frame = JSON.parse(String(data));
        if (frame.op === 2) {
          expect(frame.d.token).toBe('OFFLINE_RUNNER_TOKEN');
          expect(frame.d.intents).toBe(1 << 9);
          identified = true;
        }
        if (frame.op === 1) client.send(JSON.stringify({ op: 11 }));
      });
      client.send(JSON.stringify({ op: 10, d: { heartbeat_interval: mode === 'blackhole-stop' ? 60000 : 1000 } }));
    });
    // Redirect only the external network boundaries, not the runner, bridge, or Gateway.
    // A long sleep while live makes a missing runner wake fail without tight timing assertions.
    const code = `
    import http from 'node:http';
    import https from 'node:https';
    import timers from 'node:timers/promises';
    import {syncBuiltinESMExports} from 'node:module';
    let live = false;
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = (text, ...args) => {
      if (String(text).includes('Gateway push connected')) live = true;
      if (String(text).includes('Gateway push unavailable')) live = false;
      return write(text, ...args);
    };
    const sleep = timers.setTimeout;
    timers.setTimeout = (ms, ...args) => {
      const stretch = live && ${mode === 'push'};
      if (ms === 1000) process.send({sleep: stretch ? 60000 : ms});
      return sleep(ms === 1000 && stretch ? 60000 : ms, ...args);
    };
    https.request = (options, ...args) => {
      if (options.host !== 'gateway.discord.gg') throw new Error('Unexpected Gateway endpoint');
      return http.request({...options, protocol: 'http:', host: '127.0.0.1', hostname: '127.0.0.1', createConnection: undefined, port: ${gatewayPort}, agent: undefined}, ...args);
    };
    syncBuiltinESMExports();
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      if (!String(url).startsWith('https://discord.com/api/v10/')) throw new Error('Unexpected REST endpoint');
      return nativeFetch('http://127.0.0.1:${restPort}/messages', options);
    };
    const {runDiscordBridge} = await import('./source/services/discord/discord-command.ts');
    await runDiscordBridge([${JSON.stringify(configFile)}]);
    process.send({returned: true});
    process.disconnect();
  `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'test',
        HOME: root,
        XDG_RUNTIME_DIR: runtime,
        TERM2_DISCORD_BOT_TOKEN: 'OFFLINE_RUNNER_TOKEN',
        TERM2_DISCORD_GATEWAY: mode === 'off' ? 'off' : 'on',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const exited = once(child, 'exit');
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    });
    let output = '';
    child.stdout!.on('data', (data) => {
      output += String(data);
    });
    child.stderr!.on('data', (data) => {
      output += String(data);
    });
    const sleeps: number[] = [];
    let returned = false;
    child.on('message', (message: { sleep?: number; returned?: boolean }) => {
      if (message.sleep !== undefined) sleeps.push(message.sleep);
      if (message.returned) returned = true;
    });
    const reply = (index: number) => responses[index]!.end('[]');
    await expect.poll(() => responses.length, { timeout: 5000 }).toBe(1);
    if (mode !== 'off') {
      await expect.poll(() => identified, { timeout: 5000 }).toBe(true);
      socket!.send(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { session_id: 'runner-session' } }));
      await expect.poll(() => output, { timeout: 5000 }).toContain('Gateway push connected');
      // READY arrived mid-tick: catch up without entering the long sleep.
      reply(0);
      await expect.poll(() => responses.length, { timeout: 5000 }).toBe(2);
      if (mode === 'blackhole-stop' || mode === 'blackhole-recovery') {
        socket!.pause();
        reply(1);
        if (mode === 'blackhole-recovery') {
          await expect.poll(() => output, { timeout: 5000 }).toContain('Gateway push unavailable');
          // No nudge/30s safety read: missing ACK must restore normal REST polling.
          await expect.poll(() => responses.length, { timeout: 5000 }).toBe(3);
          reply(2);
          await expect.poll(() => connections, { timeout: 5000 }).toBe(2);
        }
        await expect.poll(() => sleeps.at(-1), { timeout: 5000 }).toBe(1000);
      } else {
        reply(1);
        await expect.poll(() => sleeps, { timeout: 5000 }).toContain(60000);
        socket!.send(
          JSON.stringify({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { channel_id: '200', author: { id: '100' } } }),
        );
        // MESSAGE_CREATE arrived asleep: the real runner must wake (not wait 60 seconds).
        await expect.poll(() => responses.length, { timeout: 5000 }).toBe(3);
        socket!.close(4004);
        await expect.poll(() => output, { timeout: 5000 }).toContain('Authentication rejected; push disabled');
        reply(2);
        await expect.poll(() => responses.length, { timeout: 5000 }).toBe(4);
        reply(3);
        await expect.poll(() => sleeps.at(-1), { timeout: 5000 }).toBe(1000);
        expect(connections).toBe(1);
      }
    } else {
      reply(0);
      await expect.poll(() => responses.length, { timeout: 5000 }).toBe(2);
      reply(1);
      expect(connections).toBe(0);
      expect(sleeps).toContain(1000);
    }
    child.kill('SIGTERM');
    await expect.poll(() => returned, { timeout: 5000 }).toBe(true);
    // Owner removal/runner return alone do not prove the socket stopped keeping Node alive.
    await expect.poll(() => child.exitCode, { timeout: 5000 }).toBe(0);
    expect((await exited)[0], output).toBe(0);
    expect(fs.existsSync(path.join(stateDir, 'owner.json'))).toBe(false);
    expect(output).not.toContain('OFFLINE_RUNNER_TOKEN');
    expect(output).not.toContain(configFile);
    expect(output).not.toContain('Credentials and payloads redacted');
  },
  20_000,
);
